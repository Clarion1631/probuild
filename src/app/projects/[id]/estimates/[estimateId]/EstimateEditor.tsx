"use client";

import { useState, useEffect } from "react";
import { saveEstimate, createInvoiceFromEstimate, deleteEstimate, duplicateEstimate, saveEstimateAsTemplate, uploadEstimateFile, deleteEstimateFile, getEstimateFiles, saveItemsAsAssembly, getEstimateTemplates, deleteAssembly } from "@/lib/actions";
import { useRouter } from "next/navigation";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";
import ExpensesTab from "./ExpensesTab";
import SendEstimateModal from "@/components/SendEstimateModal";
import SelectVendorModal from "./SelectVendorModal";
import LogPaymentModal from "./LogPaymentModal";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";
import ReusableSignaturePad from "@/components/ReusableSignaturePad";

export default function EstimateEditor({ context, initialEstimate, defaultTax }: { context: { type: "project" | "lead", id: string, name: string, clientName: string, clientEmail?: string, location?: string }, initialEstimate: any, defaultTax?: { name: string; rate: number; isDefault?: boolean } | null }) {
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
    const [showVendorSelectModal, setShowVendorSelectModal] = useState(false);
    const [isCreatingPO, setIsCreatingPO] = useState(false);
    const [isSyncingQB, setIsSyncingQB] = useState(false);
    const [showPaymentModal, setShowPaymentModal] = useState(false);
    const [processingFeeMarkup, setProcessingFeeMarkup] = useState<number>(Number(initialEstimate.processingFeeMarkup) || 0);
    const [hideProcessingFee, setHideProcessingFee] = useState<boolean>(initialEstimate.hideProcessingFee ?? true);
    const [expirationDate, setExpirationDate] = useState<string>(initialEstimate.expirationDate ? new Date(initialEstimate.expirationDate).toISOString().split("T")[0] : "");
    const [showSidebar, setShowSidebar] = useState(false);
    const [sidebarTab, setSidebarTab] = useState<"overview" | "activity">("overview");
    const [termsAndConditions, setTermsAndConditions] = useState<string>(initialEstimate.termsAndConditions || "");
    const [showTerms, setShowTerms] = useState(false);
    const [memo, setMemo] = useState<string>(initialEstimate.memo || "");
    const [estimateFiles, setEstimateFiles] = useState<any[]>(initialEstimate.files || []);
    const [isUploadingFile, setIsUploadingFile] = useState(false);
    const [signatureUrl, setSignatureUrl] = useState<string | null>(initialEstimate.signatureUrl || null);
    const [assemblies, setAssemblies] = useState<any[]>([]);
    const [showAssemblyDropdown, setShowAssemblyDropdown] = useState(false);
    const [assemblyName, setAssemblyName] = useState("");
    const [showAssemblyNameModal, setShowAssemblyNameModal] = useState(false);
    const [isSavingAssembly, setIsSavingAssembly] = useState(false);
    const [showHistoricalPricing, setShowHistoricalPricing] = useState(false);
    const [historicalAnalysis, setHistoricalAnalysis] = useState("");
    const [isLoadingHistorical, setIsLoadingHistorical] = useState(false);

    useEffect(() => {
        getEstimateTemplates().then(setAssemblies).catch(() => {});
    }, []);

    async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        if (!file) return;
        setIsUploadingFile(true);
        try {
            const formData = new FormData();
            formData.append("file", file);
            await uploadEstimateFile(initialEstimate.id, formData);
            const files = await getEstimateFiles(initialEstimate.id);
            setEstimateFiles(files);
            toast.success("File uploaded");
        } catch (err: any) {
            toast.error(err.message || "Failed to upload file");
        } finally {
            setIsUploadingFile(false);
            e.target.value = "";
        }
    }

    async function handleDeleteFile(fileId: string) {
        if (!confirm("Delete this file?")) return;
        try {
            await deleteEstimateFile(fileId);
            setEstimateFiles(prev => prev.filter(f => f.id !== fileId));
            toast.success("File deleted");
        } catch {
            toast.error("Failed to delete file");
        }
    }

    function formatFileSize(bytes: number): string {
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
        return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    }

    function handleCreateAssembly() {
        if (selectedItemIds.length < 2) {
            toast.error("Select at least 2 items to create an assembly");
            return;
        }
        setAssemblyName("");
        setShowAssemblyNameModal(true);
    }

    async function handleSaveAssembly() {
        if (!assemblyName.trim()) {
            toast.error("Enter a name for the assembly");
            return;
        }
        setIsSavingAssembly(true);
        try {
            const selectedItems = items.filter(item => selectedItemIds.includes(item.id));
            await saveItemsAsAssembly(assemblyName.trim(), selectedItems.map((item, idx) => ({
                name: item.name,
                description: item.description || "",
                type: item.type,
                quantity: item.quantity,
                baseCost: Number(item.baseCost) || 0,
                markupPercent: item.markupPercent,
                unitCost: Number(item.unitCost) || 0,
                order: idx,
                costCodeId: item.costCodeId,
                costTypeId: item.costTypeId,
            })));
            // Also group in current estimate
            const sectionId = generateId();
            const newItems = items.map(item =>
                selectedItemIds.includes(item.id) ? { ...item, parentId: sectionId } : item
            );
            const insertAt = newItems.findIndex(item => item.parentId === sectionId);
            newItems.splice(insertAt, 0, {
                id: sectionId, name: assemblyName.trim(), description: "", type: "Section",
                quantity: 1, baseCost: 0, markupPercent: 0, unitCost: 0, total: 0,
                parentId: null, costCodeId: null, costTypeId: null, isSection: true,
            });
            setItems(newItems);
            setSelectedItemIds([]);
            setShowAssemblyNameModal(false);
            const updated = await getEstimateTemplates();
            setAssemblies(updated);
            toast.success(`Assembly "${assemblyName.trim()}" saved`);
        } catch (err: any) {
            toast.error(err.message || "Failed to save assembly");
        } finally {
            setIsSavingAssembly(false);
        }
    }

    function handleInsertAssembly(assembly: any) {
        const newItems = [...items];
        const sectionId = generateId();
        newItems.push({
            id: sectionId, name: assembly.name, description: "", type: "Section",
            quantity: 1, baseCost: 0, markupPercent: 0, unitCost: 0, total: 0,
            parentId: null, costCodeId: null, costTypeId: null, isSection: true,
        });
        for (const tItem of assembly.items) {
            newItems.push({
                id: generateId(), name: tItem.name, description: tItem.description || "",
                type: tItem.type, quantity: tItem.quantity,
                baseCost: Number(tItem.baseCost) || 0, markupPercent: tItem.markupPercent,
                unitCost: Number(tItem.unitCost) || 0,
                total: (tItem.quantity || 0) * (Number(tItem.unitCost) || 0),
                parentId: sectionId, costCodeId: tItem.costCodeId, costTypeId: tItem.costTypeId,
            });
        }
        setItems(newItems);
        setShowAssemblyDropdown(false);
        toast.success(`Inserted "${assembly.name}"`);
    }

    async function handleDeleteAssembly(assemblyId: string, e: React.MouseEvent) {
        e.stopPropagation();
        if (!confirm("Delete this assembly?")) return;
        try {
            await deleteAssembly(assemblyId);
            setAssemblies(prev => prev.filter(a => a.id !== assemblyId));
            toast.success("Assembly deleted");
        } catch { toast.error("Failed to delete assembly"); }
    }

    async function handleHistoricalPricing() {
        setIsLoadingHistorical(true);
        setHistoricalAnalysis("");
        setShowHistoricalPricing(true);
        try {
            const res = await fetch('/api/ai/historical-pricing', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ estimateId: initialEstimate.id }),
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                toast.error(data.error || 'Failed to analyze historical pricing');
                setShowHistoricalPricing(false);
                return;
            }
            setHistoricalAnalysis(data.analysis);
        } catch (err: any) {
            console.error('Historical pricing error:', err);
            toast.error('Failed to load historical pricing');
            setShowHistoricalPricing(false);
        } finally {
            setIsLoadingHistorical(false);
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
            if (data.notConnected) {
                toast.error("QuickBooks not connected — go to Settings → Integrations to connect.");
                return;
            }
            if (!res.ok) throw new Error(data.error || "Sync failed");
            toast.success("Estimate synced to QuickBooks!", {
                action: data.qbUrl ? { label: "View in QB", onClick: () => window.open(data.qbUrl, "_blank") } : undefined,
            });
        } catch (e: any) {
            toast.error(e.message || "Failed to sync to QuickBooks");
        } finally {
            setIsSyncingQB(false);
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
    const taxRate = defaultTax ? defaultTax.rate / 100 : 0.087;
    const taxName = defaultTax ? `${defaultTax.name} (${defaultTax.rate}%)` : "Estimated Tax (8.7%)";
    const processingFee = processingFeeMarkup > 0 ? subtotal * (processingFeeMarkup / 100) : 0;
    const tax = subtotal * taxRate;
    const total = subtotal + tax + processingFee;

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
            title, code, status, totalAmount: total, paymentSchedules: mappedSchedules,
            processingFeeMarkup, hideProcessingFee,
            expirationDate: expirationDate ? new Date(expirationDate).toISOString() : null,
            memo: memo || null,
            termsAndConditions: termsAndConditions || null,
            signatureUrl: signatureUrl || null,
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
                toast.success(`AI generated ${data.count} items (est. ${formatCurrency(Number(data.totalEstimate || 0))})`);
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
                const newTotal = newSubtotal + newSubtotal * taxRate;
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
                    <select
                        value={status}
                        onChange={e => setStatus(e.target.value)}
                        className={`px-2 py-0.5 rounded text-xs font-semibold border cursor-pointer ${
                            status === "Draft" ? "bg-slate-100 text-slate-600 border-slate-200" :
                            status === "Sent" ? "bg-amber-50 text-amber-700 border-amber-200" :
                            status === "Viewed" ? "bg-blue-50 text-blue-700 border-blue-200" :
                            status === "Approved" ? "bg-green-50 text-green-700 border-green-200" :
                            status === "Invoiced" ? "bg-teal-50 text-teal-700 border-teal-200" :
                            status === "Paid" ? "bg-emerald-50 text-emerald-700 border-emerald-200" :
                            "bg-slate-100 text-hui-textMuted border-hui-border"
                        }`}
                    >
                        {["Draft", "Sent", "Viewed", "Approved", "Invoiced", "Paid"].map(s => (
                            <option key={s} value={s}>{s}</option>
                        ))}
                    </select>
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
                                        href={`/api/pdf/estimates/${initialEstimate.id}?inline=true`}
                                        target="_blank"
                                        onClick={() => setShowMoreMenu(false)}
                                        className="w-full text-left px-4 py-2.5 hover:bg-slate-50 flex items-center gap-2.5 text-hui-textMain"
                                    >
                                        <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg>
                                        Preview PDF
                                    </a>
                                    <a
                                        href={`/api/pdf/estimates/${initialEstimate.id}`}
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
                                    {context.type === "project" && selectedItemIds.length > 0 && (
                                        <>
                                            <div className="border-t border-hui-border my-1" />
                                            <button
                                                onClick={() => { handleCreateChangeOrder(); setShowMoreMenu(false); }}
                                                disabled={isCreatingCO || isCreatingPO}
                                                className="w-full text-left px-4 py-2.5 hover:bg-amber-50 flex items-center gap-2.5 text-amber-700 disabled:opacity-50"
                                            >
                                                <svg className="w-4 h-4 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
                                                {isCreatingCO ? "Creating..." : `Create Change Order (${selectedItemIds.length})`}
                                            </button>
                                            <button
                                                onClick={() => { setShowVendorSelectModal(true); setShowMoreMenu(false); }}
                                                disabled={isCreatingCO || isCreatingPO}
                                                className="w-full text-left px-4 py-2.5 hover:bg-emerald-50 flex items-center gap-2.5 text-emerald-700 disabled:opacity-50"
                                            >
                                                <svg className="w-4 h-4 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" /></svg>
                                                {isCreatingPO ? "Creating PO..." : `Create Purchase Order (${selectedItemIds.length})`}
                                            </button>
                                        </>
                                    )}
                                    <button
                                        onClick={() => { setShowPaymentModal(true); setShowMoreMenu(false); }}
                                        className="w-full text-left px-4 py-2.5 hover:bg-emerald-50 flex items-center gap-2.5 text-emerald-700"
                                    >
                                        <svg className="w-4 h-4 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                                        Log Payment
                                    </button>
                                    <div className="border-t border-hui-border my-1" />
                                    <button
                                        onClick={handleSyncQB}
                                        disabled={isSyncingQB}
                                        className="w-full text-left px-4 py-2.5 hover:bg-green-50 flex items-center gap-2.5 text-green-700 disabled:opacity-50"
                                    >
                                        <span className="w-4 h-4 text-[11px] font-bold flex items-center justify-center">QB</span>
                                        {isSyncingQB ? "Syncing…" : "Sync to QuickBooks"}
                                    </button>
                                    <div className="border-t border-hui-border my-1" />
                                    <button
                                        onClick={async () => {
                                            setShowMoreMenu(false);
                                            try {
                                                const { archiveEstimate } = await import("@/lib/actions");
                                                const res = await archiveEstimate(initialEstimate.id);
                                                toast.success(res.archived ? "Estimate archived" : "Estimate unarchived");
                                                router.refresh();
                                            } catch (err: any) {
                                                toast.error(err.message || "Failed to archive");
                                            }
                                        }}
                                        className="w-full text-left px-4 py-2.5 hover:bg-amber-50 flex items-center gap-2.5 text-amber-700"
                                    >
                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" /></svg>
                                        {initialEstimate.archivedAt ? "Unarchive" : "Archive"}
                                    </button>
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
                        onClick={handleHistoricalPricing}
                        disabled={isLoadingHistorical}
                        className="hui-btn hui-btn-secondary bg-gradient-to-r from-teal-50 to-cyan-50 border-teal-200 text-teal-700 hover:from-teal-100 hover:to-cyan-100 flex items-center gap-2 disabled:opacity-50"
                    >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
                        {isLoadingHistorical ? "Analyzing..." : "Historical Pricing"}
                    </button>
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
                    <button
                        onClick={() => setShowSidebar(!showSidebar)}
                        className={`hui-btn hui-btn-secondary px-2.5 ${showSidebar ? 'bg-slate-100' : ''}`}
                        title="Toggle sidebar"
                    >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h7" /></svg>
                    </button>
                </div>
            </div>

            {/* Selected Items Action Bar + Insert Assembly */}
            <div className="bg-amber-50 border-b border-amber-200 px-6 py-2 flex items-center gap-3 text-sm">
                {selectedItemIds.length > 0 ? (
                    <>
                        <span className="font-medium text-amber-800">{selectedItemIds.length} item{selectedItemIds.length > 1 ? 's' : ''} selected</span>
                        <div className="h-4 w-px bg-amber-300"></div>
                        <button onClick={handleCreateAssembly} className="hui-btn hui-btn-secondary text-xs py-1 px-3 border-amber-300 text-amber-800 hover:bg-amber-100 flex items-center gap-1.5">
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" /></svg>
                            Save as Assembly
                        </button>
                        <button onClick={() => setSelectedItemIds([])} className="text-amber-600 hover:text-amber-800 text-xs font-medium ml-auto">
                            Clear selection
                        </button>
                    </>
                ) : (
                    <div className="relative">
                        <button onClick={() => setShowAssemblyDropdown(!showAssemblyDropdown)} className="hui-btn hui-btn-secondary text-xs py-1 px-3 border-amber-300 text-amber-800 hover:bg-amber-100 flex items-center gap-1.5">
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" /></svg>
                            Insert Assembly
                            <svg className="w-3 h-3 ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                        </button>
                        {showAssemblyDropdown && (
                            <div className="absolute top-full left-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg z-50 w-72 max-h-64 overflow-y-auto">
                                {assemblies.length === 0 ? (
                                    <div className="p-4 text-center text-slate-400 text-xs">No saved assemblies yet. Select items and click &quot;Save as Assembly&quot; to create one.</div>
                                ) : (
                                    assemblies.map(a => (
                                        <div key={a.id} onClick={() => handleInsertAssembly(a)} className="px-4 py-3 hover:bg-slate-50 cursor-pointer border-b border-slate-50 last:border-0 flex items-center justify-between group">
                                            <div>
                                                <p className="text-sm font-medium text-slate-800">{a.name}</p>
                                                <p className="text-xs text-slate-400">{a.items.length} item{a.items.length !== 1 ? 's' : ''}</p>
                                            </div>
                                            <button onClick={(e) => handleDeleteAssembly(a.id, e)} className="text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition p-1" title="Delete assembly">
                                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                                            </button>
                                        </div>
                                    ))
                                )}
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* Assembly Name Modal */}
            {showAssemblyNameModal && (
                <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center" onClick={() => setShowAssemblyNameModal(false)}>
                    <div className="bg-white rounded-xl shadow-2xl p-6 w-96" onClick={e => e.stopPropagation()}>
                        <h3 className="text-lg font-bold text-slate-800 mb-1">Save Assembly</h3>
                        <p className="text-sm text-slate-500 mb-4">Name this bundle so you can reuse it across estimates (e.g., &quot;Standard Bathroom Demo&quot;).</p>
                        <input
                            autoFocus
                            type="text"
                            value={assemblyName}
                            onChange={e => setAssemblyName(e.target.value)}
                            onKeyDown={e => e.key === "Enter" && handleSaveAssembly()}
                            placeholder="Assembly name..."
                            className="hui-input w-full mb-4"
                        />
                        <div className="flex justify-end gap-2">
                            <button onClick={() => setShowAssemblyNameModal(false)} className="hui-btn hui-btn-secondary text-sm">Cancel</button>
                            <button onClick={handleSaveAssembly} disabled={isSavingAssembly} className="hui-btn hui-btn-primary text-sm">
                                {isSavingAssembly ? "Saving..." : "Save Assembly"}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <div className="flex-1 flex overflow-hidden">
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

                                            <label className="text-slate-500 font-medium">Expires</label>
                                            <input
                                                type="date"
                                                value={expirationDate}
                                                onChange={e => setExpirationDate(e.target.value)}
                                                className="font-medium text-slate-800 focus:outline-none focus:bg-white focus:ring-1 ring-slate-200 rounded px-2 py-1 -mr-2 text-right bg-transparent transition text-sm"
                                            />
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
                                                                        placeholder="Item name"
                                                                        className={`w-full bg-transparent focus:outline-none focus:bg-white focus:ring-1 ring-hui-border rounded px-2 py-1 -ml-2 transition text-sm ${isSubItem ? 'text-hui-textMuted' : 'font-medium text-hui-textMain'}`}
                                                                    />
                                                                    <textarea
                                                                        value={item.description || ""}
                                                                        onChange={e => updateItem(index, "description", e.target.value)}
                                                                        placeholder="Description (optional)"
                                                                        rows={1}
                                                                        className="w-full bg-transparent focus:outline-none focus:bg-white focus:ring-1 ring-hui-border rounded px-2 py-0.5 -ml-2 transition text-xs text-hui-textMuted resize-none mt-0.5"
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
                                                                        {formatCurrency(itemTotal)}
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
                                        <span className="text-slate-800">{formatCurrency(subtotal)}</span>
                                    </div>
                                    <div className="flex justify-between text-slate-500 font-medium">
                                        <span>{taxName}</span>
                                        <span className="text-slate-800">{formatCurrency(tax)}</span>
                                    </div>
                                    {/* Processing Fee Markup — hidden from client view by default */}
                                    {(viewMode === "internal" || !hideProcessingFee) && (
                                        <div className="flex justify-between items-center text-slate-500 font-medium">
                                            <div className="flex items-center gap-2">
                                                <span>Processing Fee{processingFeeMarkup > 0 ? ` (${processingFeeMarkup}%)` : ""}</span>
                                                {viewMode === "internal" && (
                                                    <button
                                                        onClick={() => setHideProcessingFee(!hideProcessingFee)}
                                                        title={hideProcessingFee ? "Hidden from client" : "Visible to client"}
                                                        className="text-slate-400 hover:text-slate-600 transition"
                                                    >
                                                        {hideProcessingFee ? (
                                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" /></svg>
                                                        ) : (
                                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                                                        )}
                                                    </button>
                                                )}
                                            </div>
                                            {viewMode === "internal" ? (
                                                <div className="flex items-center gap-1">
                                                    <input
                                                        type="number"
                                                        value={processingFeeMarkup}
                                                        onChange={e => setProcessingFeeMarkup(parseFloat(e.target.value) || 0)}
                                                        className="w-16 bg-transparent focus:outline-none focus:bg-white focus:ring-1 ring-slate-200 rounded px-2 py-0.5 text-right text-sm"
                                                        step="0.5"
                                                        min="0"
                                                    />
                                                    <span className="text-xs text-slate-400">%</span>
                                                </div>
                                            ) : (
                                                <span className="text-slate-800">{formatCurrency(processingFee)}</span>
                                            )}
                                        </div>
                                    )}
                                    <div className="h-px w-full bg-slate-200 my-4 shadow-sm"></div>
                                    <div className="flex justify-between text-xl font-extrabold text-slate-900">
                                        <span>Total</span>
                                        <span className="text-indigo-600">{formatCurrency(total)}</span>
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
                                            <div className="font-bold text-amber-900">{formatCurrency(totalBaseCost)}</div>
                                        </div>
                                        <div className="text-center">
                                            <div className="text-[10px] text-amber-600 font-semibold uppercase">Markup</div>
                                            <div className="font-bold text-amber-900">{formatCurrency(totalMarkup)}</div>
                                        </div>
                                        <div className="text-center">
                                            <div className="text-[10px] text-amber-600 font-semibold uppercase">Margin</div>
                                            <div className="font-bold text-amber-900">{profitMargin.toFixed(1)}%</div>
                                        </div>
                                        <div className="text-center">
                                            <div className="text-[10px] text-amber-600 font-semibold uppercase">Sell Price</div>
                                            <div className="font-bold text-amber-900">{formatCurrency(subtotal)}</div>
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

                        {/* Memo / Notes */}
                        <div className="mt-8 mx-2">
                            <label className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-2 block px-1">Memo / Notes</label>
                            <textarea
                                value={memo}
                                onChange={e => setMemo(e.target.value)}
                                placeholder="Add a memo or note for this estimate (visible on the estimate document)..."
                                className="w-full border border-slate-200 rounded-lg px-4 py-3 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-300 resize-none transition bg-white"
                                rows={3}
                            />
                        </div>

                        {/* Files Section */}
                        <div className="mt-8 mx-2">
                            <label className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-2 block px-1">Attached Files</label>
                            <div className="bg-white rounded-xl border border-slate-200 p-4">
                                {estimateFiles.length > 0 && (
                                    <div className="space-y-2 mb-3">
                                        {estimateFiles.map((f: any) => (
                                            <div key={f.id} className="flex items-center justify-between bg-slate-50 rounded-lg px-3 py-2 group">
                                                <a href={f.url} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-sm text-hui-textMain hover:text-hui-primary transition truncate">
                                                    <svg className="w-4 h-4 text-slate-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg>
                                                    <span className="truncate">{f.name}</span>
                                                    <span className="text-xs text-slate-400 flex-shrink-0">{formatFileSize(f.size)}</span>
                                                </a>
                                                <button onClick={() => handleDeleteFile(f.id)} className="text-slate-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition ml-2" title="Delete">
                                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" /></svg>
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                )}
                                <label className={`flex items-center justify-center gap-2 border-2 border-dashed border-slate-200 rounded-lg px-4 py-3 cursor-pointer hover:border-indigo-300 hover:bg-indigo-50/30 transition ${isUploadingFile ? "opacity-50 pointer-events-none" : ""}`}>
                                    <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                                    <span className="text-sm text-slate-500">{isUploadingFile ? "Uploading..." : "Upload File"}</span>
                                    <input type="file" className="hidden" onChange={handleFileUpload} disabled={isUploadingFile} />
                                </label>
                            </div>
                        </div>

                        {/* Terms & Conditions Section */}
                        <div className="mt-8 mx-2">
                            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                                <button
                                    onClick={() => setShowTerms(!showTerms)}
                                    className="w-full flex items-center justify-between px-6 py-4 hover:bg-slate-50 transition"
                                >
                                    <div className="flex items-center gap-2">
                                        <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                                        <span className="text-sm font-semibold text-slate-800">Terms & Conditions</span>
                                        {termsAndConditions && <span className="text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full font-medium">Added</span>}
                                    </div>
                                    <svg className={`w-4 h-4 text-slate-400 transition-transform ${showTerms ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                                </button>
                                {showTerms && (
                                    <div className="px-6 pb-5 border-t border-slate-100">
                                        <p className="text-xs text-slate-500 mt-3 mb-2">These terms will be included on the estimate sent to the client.</p>
                                        <textarea
                                            value={termsAndConditions}
                                            onChange={e => setTermsAndConditions(e.target.value)}
                                            placeholder="Enter your terms and conditions here. For example: Payment is due within 30 days of invoice. A 50% deposit is required before work begins..."
                                            className="hui-input w-full h-32 resize-y text-sm"
                                        />
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Signature Section */}
                        <div className="mt-8 mx-2">
                            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                                <div className="flex items-center justify-between px-6 py-4">
                                    <div className="flex items-center gap-2">
                                        <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                                        <span className="text-sm font-semibold text-slate-800">Client Signature</span>
                                        {signatureUrl && <span className="text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full font-medium">Signed</span>}
                                    </div>
                                    {signatureUrl && (
                                        <button onClick={() => setSignatureUrl(null)} className="text-xs text-red-500 hover:text-red-700 font-medium">Clear Signature</button>
                                    )}
                                </div>
                                <div className="px-6 pb-5 border-t border-slate-100">
                                    {signatureUrl ? (
                                        <div className="mt-3 bg-slate-50 rounded-lg p-4 border border-slate-100 flex items-center gap-4">
                                            <img src={signatureUrl} alt="Client signature" className="max-h-20 rounded" />
                                            <div>
                                                <p className="text-xs text-green-600 font-semibold">Signature captured</p>
                                                <p className="text-xs text-slate-400 mt-0.5">Will be saved with the estimate</p>
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="mt-3">
                                            <p className="text-xs text-slate-500 mb-3">Draw signature below. This will be included on the signed estimate.</p>
                                            <ReusableSignaturePad onSignatureChange={(dataUrl: string | null) => setSignatureUrl(dataUrl)} />
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>

                        {/* Internal Memo Section (only in internal view) — disabled: uses same memo field */}
                        {false && viewMode === "internal" && (
                            <div className="mt-6 mx-2">
                                <div className="bg-amber-50/50 rounded-xl border border-amber-200 overflow-hidden">
                                    <div className="flex items-center gap-2 px-6 py-3">
                                        <svg className="w-4 h-4 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
                                        <span className="text-sm font-semibold text-amber-800">Internal Memo</span>
                                        <span className="text-[10px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full font-medium">Not visible to client</span>
                                    </div>
                                    <div className="px-6 pb-4">
                                        <textarea
                                            value={memo}
                                            onChange={e => setMemo(e.target.value)}
                                            placeholder="Internal notes about this estimate..."
                                            className="w-full h-20 resize-y text-sm bg-white border border-amber-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-amber-300 placeholder:text-amber-400"
                                        />
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                )}
                {activeTab === "expenses" && (
                    <div className="w-full max-w-5xl bg-white rounded-xl shadow-[0_8px_30px_rgb(0,0,0,0.04)] border border-slate-200 overflow-visible relative">
                        <div className="h-1.5 w-full bg-gradient-to-r from-emerald-500 via-teal-500 to-cyan-500"></div>
                        <ExpensesTab estimateId={initialEstimate.id} projectId={context.type === "project" ? context.id : ""} items={items} />
                    </div>
                )}
            </div>

            {/* Right Sidebar */}
            {showSidebar && (
                <div className="w-80 border-l border-slate-200 bg-white flex flex-col overflow-y-auto shrink-0">
                    {/* Sidebar Tabs */}
                    <div className="flex border-b border-slate-200 sticky top-0 bg-white z-10">
                        <button
                            onClick={() => setSidebarTab("overview")}
                            className={`flex-1 px-4 py-3 text-sm font-medium transition ${sidebarTab === "overview" ? "text-indigo-600 border-b-2 border-indigo-600" : "text-slate-500 hover:text-slate-700"}`}
                        >Overview</button>
                        <button
                            onClick={() => setSidebarTab("activity")}
                            className={`flex-1 px-4 py-3 text-sm font-medium transition ${sidebarTab === "activity" ? "text-indigo-600 border-b-2 border-indigo-600" : "text-slate-500 hover:text-slate-700"}`}
                        >Activity</button>
                    </div>

                    {sidebarTab === "overview" && (
                        <div className="p-5 space-y-5">
                            {/* Status */}
                            <div>
                                <label className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-2 block">Status</label>
                                <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${
                                    status === "Draft" ? "bg-slate-100 text-slate-600" :
                                    status === "Sent" ? "bg-amber-50 text-amber-700" :
                                    status === "Viewed" ? "bg-blue-50 text-blue-700" :
                                    status === "Approved" ? "bg-green-50 text-green-700" :
                                    status === "Invoiced" ? "bg-teal-50 text-teal-700" :
                                    status === "Paid" ? "bg-emerald-50 text-emerald-700" :
                                    "bg-slate-100 text-slate-500"
                                }`}>{status}</span>
                            </div>

                            {/* Amounts */}
                            <div className="space-y-3">
                                <label className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 block">Financials</label>
                                <div className="grid grid-cols-2 gap-3">
                                    <div className="bg-slate-50 rounded-lg p-3">
                                        <p className="text-[10px] text-slate-500 font-medium uppercase">Subtotal</p>
                                        <p className="text-sm font-bold text-slate-800">{formatCurrency(subtotal)}</p>
                                    </div>
                                    <div className="bg-indigo-50 rounded-lg p-3">
                                        <p className="text-[10px] text-indigo-500 font-medium uppercase">Total</p>
                                        <p className="text-sm font-bold text-indigo-700">{formatCurrency(total)}</p>
                                    </div>
                                </div>
                                {viewMode === "internal" && (
                                    <div className="bg-amber-50 rounded-lg p-3">
                                        <p className="text-[10px] text-amber-600 font-medium uppercase">Profit Margin</p>
                                        <p className="text-sm font-bold text-amber-800">{profitMargin.toFixed(1)}% ({formatCurrency(totalMarkup)})</p>
                                    </div>
                                )}
                            </div>

                            {/* Key Dates */}
                            <div className="space-y-2">
                                <label className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 block">Key Dates</label>
                                <div className="space-y-2 text-sm">
                                    <div className="flex justify-between">
                                        <span className="text-slate-500">Created</span>
                                        <span className="text-slate-800 font-medium">{new Date(initialEstimate.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                                    </div>
                                    {initialEstimate.sentAt && (
                                        <div className="flex justify-between">
                                            <span className="text-slate-500">Sent</span>
                                            <span className="text-slate-800 font-medium">{new Date(initialEstimate.sentAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                                        </div>
                                    )}
                                    {initialEstimate.viewedAt && (
                                        <div className="flex justify-between">
                                            <span className="text-slate-500">Viewed</span>
                                            <span className="text-slate-800 font-medium">{new Date(initialEstimate.viewedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                                        </div>
                                    )}
                                    {initialEstimate.approvedAt && (
                                        <div className="flex justify-between">
                                            <span className="text-slate-500">Approved</span>
                                            <span className="text-green-700 font-medium">{new Date(initialEstimate.approvedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                                        </div>
                                    )}
                                    {expirationDate && (
                                        <div className="flex justify-between">
                                            <span className="text-slate-500">Expires</span>
                                            <span className={`font-medium ${new Date(expirationDate) < new Date() ? 'text-red-600' : 'text-slate-800'}`}>{new Date(expirationDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* Client Info */}
                            <div className="space-y-2">
                                <label className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 block">Client</label>
                                <div className="bg-slate-50 rounded-lg p-3 space-y-1">
                                    <p className="text-sm font-semibold text-slate-800">{context.clientName}</p>
                                    {context.clientEmail && <p className="text-xs text-slate-500">{context.clientEmail}</p>}
                                    {context.location && <p className="text-xs text-slate-500">{context.location}</p>}
                                </div>
                            </div>

                            {/* Signature */}
                            {initialEstimate.signatureUrl && (
                                <div className="space-y-2">
                                    <label className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 block">Signature</label>
                                    <div className="bg-green-50 rounded-lg p-3 border border-green-200">
                                        <div className="flex items-center gap-2 mb-2">
                                            <svg className="w-4 h-4 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                                            <span className="text-xs font-semibold text-green-700">Signed by {initialEstimate.approvedBy || 'Client'}</span>
                                        </div>
                                        <img src={initialEstimate.signatureUrl} alt="Signature" className="max-h-16 rounded" />
                                    </div>
                                </div>
                            )}

                            {/* Items Summary */}
                            <div>
                                <label className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-2 block">Items</label>
                                <div className="text-sm text-slate-600">
                                    <span className="font-semibold text-slate-800">{items.length}</span> line items
                                    {paymentSchedules.length > 0 && (
                                        <> &middot; <span className="font-semibold text-slate-800">{paymentSchedules.length}</span> payment milestones</>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}

                    {sidebarTab === "activity" && (
                        <div className="p-5">
                            <div className="space-y-4">
                                {/* Activity Timeline */}
                                <div className="relative">
                                    <div className="absolute left-[11px] top-6 bottom-0 w-0.5 bg-slate-200"></div>
                                    <div className="space-y-4">
                                        <div className="flex items-start gap-3 relative">
                                            <div className="w-6 h-6 rounded-full bg-slate-200 flex items-center justify-center shrink-0 z-10">
                                                <svg className="w-3 h-3 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" /></svg>
                                            </div>
                                            <div>
                                                <p className="text-sm font-medium text-slate-800">Estimate created</p>
                                                <p className="text-xs text-slate-500">{new Date(initialEstimate.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}</p>
                                            </div>
                                        </div>
                                        {initialEstimate.sentAt && (
                                            <div className="flex items-start gap-3 relative">
                                                <div className="w-6 h-6 rounded-full bg-amber-100 flex items-center justify-center shrink-0 z-10">
                                                    <svg className="w-3 h-3 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" /></svg>
                                                </div>
                                                <div>
                                                    <p className="text-sm font-medium text-slate-800">Sent to client</p>
                                                    <p className="text-xs text-slate-500">{new Date(initialEstimate.sentAt).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}</p>
                                                </div>
                                            </div>
                                        )}
                                        {initialEstimate.viewedAt && (
                                            <div className="flex items-start gap-3 relative">
                                                <div className="w-6 h-6 rounded-full bg-blue-100 flex items-center justify-center shrink-0 z-10">
                                                    <svg className="w-3 h-3 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                                                </div>
                                                <div>
                                                    <p className="text-sm font-medium text-slate-800">Viewed by client</p>
                                                    <p className="text-xs text-slate-500">{new Date(initialEstimate.viewedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}</p>
                                                </div>
                                            </div>
                                        )}
                                        {initialEstimate.approvedAt && (
                                            <div className="flex items-start gap-3 relative">
                                                <div className="w-6 h-6 rounded-full bg-green-100 flex items-center justify-center shrink-0 z-10">
                                                    <svg className="w-3 h-3 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                                                </div>
                                                <div>
                                                    <p className="text-sm font-medium text-slate-800">Approved{initialEstimate.approvedBy ? ` by ${initialEstimate.approvedBy}` : ''}</p>
                                                    <p className="text-xs text-slate-500">{new Date(initialEstimate.approvedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}</p>
                                                </div>
                                            </div>
                                        )}
                                        {!initialEstimate.sentAt && !initialEstimate.viewedAt && !initialEstimate.approvedAt && (
                                            <div className="mt-4 text-center py-6">
                                                <svg className="w-10 h-10 text-slate-300 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                                                <p className="text-sm text-slate-500">No activity yet</p>
                                                <p className="text-xs text-slate-400 mt-1">Send the estimate to start tracking</p>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}
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

            {/* Historical Pricing Modal */}
            {showHistoricalPricing && (
                <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
                    <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full overflow-hidden border border-teal-200">
                        <div className="px-6 py-4 border-b border-teal-100 bg-gradient-to-r from-teal-50 to-cyan-50 flex justify-between items-center">
                            <div className="flex items-center gap-3">
                                <div className="w-8 h-8 rounded-lg bg-teal-100 flex items-center justify-center">
                                    <svg className="w-4 h-4 text-teal-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
                                </div>
                                <div>
                                    <h2 className="text-lg font-bold text-hui-textMain">Historical Pricing Analysis</h2>
                                    <p className="text-xs text-teal-600">AI-powered insights from your past projects</p>
                                </div>
                            </div>
                            <button onClick={() => setShowHistoricalPricing(false)} className="text-hui-textMuted hover:text-hui-textMain transition">
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                            </button>
                        </div>
                        <div className="p-6 max-h-[60vh] overflow-y-auto">
                            {isLoadingHistorical ? (
                                <div className="flex flex-col items-center justify-center py-12 gap-3">
                                    <svg className="w-8 h-8 animate-spin text-teal-500" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                                    <p className="text-sm text-hui-textMuted">Analyzing pricing data from all your past projects...</p>
                                </div>
                            ) : (
                                <div className="prose prose-sm max-w-none text-hui-textMain whitespace-pre-wrap">
                                    {historicalAnalysis}
                                </div>
                            )}
                        </div>
                        <div className="px-6 py-4 border-t border-hui-border flex justify-end bg-slate-50">
                            <button
                                onClick={() => setShowHistoricalPricing(false)}
                                className="hui-btn hui-btn-secondary"
                            >
                                Close
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

            {showVendorSelectModal && (
                <SelectVendorModal
                    onSelect={handleCreatePurchaseOrder}
                    onClose={() => setShowVendorSelectModal(false)}
                />
            )}

            {showPaymentModal && (
                <LogPaymentModal
                    estimateId={initialEstimate.id}
                    balanceDue={Number(initialEstimate.balanceDue) || 0}
                    onClose={() => setShowPaymentModal(false)}
                    onSaved={() => router.refresh()}
                />
            )}
        </div>
    );
}

