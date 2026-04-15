"use client";

/** Round to 2 decimal places to avoid IEEE 754 penny drift in money calculations */
const rm = (n: number) => Math.round(n * 100) / 100;

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { saveEstimate, createInvoiceFromEstimate, deleteEstimate, duplicateEstimate, saveEstimateAsTemplate, uploadEstimateFile, deleteEstimateFile, getEstimateFiles, saveItemsAsAssembly, getEstimateTemplates, deleteAssembly, updateItemApproval, bulkUpdateItemApproval, linkPOToEstimateItem, unlinkPOFromEstimateItem, getProjectPurchaseOrdersForLinking } from "@/lib/actions";
import { useRouter } from "next/navigation";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";
import ExpensesTab from "./ExpensesTab";
import SendEstimateModal from "@/components/SendEstimateModal";
import SelectVendorModal from "./SelectVendorModal";
import LogPaymentModal from "./LogPaymentModal";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";
import ReusableSignaturePad from "@/components/ReusableSignaturePad";
import DocumentComments from "@/components/DocumentComments";
import BudgetStrip from "./BudgetStrip";
import POQuickCreateModal from "./POQuickCreateModal";
import { internalBudget, sellFromMargin } from "@/lib/budget-math";

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
    const [aiFillItemId, setAiFillItemId] = useState<string | null>(null);
    const [isAiFilling, setIsAiFilling] = useState(false);
    const [expirationDate, setExpirationDate] = useState<string>(initialEstimate.expirationDate ? new Date(initialEstimate.expirationDate).toISOString().split("T")[0] : "");
    const [showSidebar, setShowSidebar] = useState(false);
    const [sidebarTab, setSidebarTab] = useState<"overview" | "activity" | "comments" | "history">("overview");
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
    const [aiSuggestingDesc, setAiSuggestingDesc] = useState<string | null>(null); // item ID currently suggesting for
    const [aiSuggestingSubitems, setAiSuggestingSubitems] = useState<string | null>(null); // item ID
    const [aiSubitemSuggestions, setAiSubitemSuggestions] = useState<any[]>([]);
    const [showSubitemSuggestions, setShowSubitemSuggestions] = useState<string | null>(null);
    const [selectedSuggestionIndices, setSelectedSuggestionIndices] = useState<Set<number>>(new Set());
    const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
    const [history, setHistory] = useState<Array<{ ts: number; label: string; snapshot: any[] }>>([]);
    const [showHistory, setShowHistory] = useState(false);
    const [expandedHistoryTs, setExpandedHistoryTs] = useState<number | null>(null);
    const [poCreateItemId, setPOCreateItemId] = useState<string | null>(null);
    const [poLinkItemId, setPOLinkItemId] = useState<string | null>(null);
    const [projectPOs, setProjectPOs] = useState<any[]>([]);
    const [loadingPOs, setLoadingPOs] = useState(false);

    // Derived: sum of children totals per section header
    const sectionTotals = useMemo(() => {
        const map = new Map<string, number>();
        for (const item of items) {
            if (item.parentId) {
                map.set(item.parentId, (map.get(item.parentId) || 0) + rm((parseFloat(item.quantity) || 0) * (parseFloat(item.unitCost) || 0)));
            }
        }
        return map;
    }, [items]);

    // A row is a section header if it has no parentId and at least one child references it
    const sectionIds = useMemo(() => new Set(items.filter(i => i.parentId).map((i: any) => i.parentId)), [items]);

    // Auto-expand textarea ref handler
    const autoExpand = useCallback((el: HTMLTextAreaElement | null) => {
        if (!el) return;
        el.style.height = "auto";
        el.style.height = el.scrollHeight + "px";
    }, []);

    // AI description suggestion
    async function suggestDescription(itemIndex: number) {
        const item = items[itemIndex];
        if (!item?.name?.trim() || aiSuggestingDesc === item.id) return;
        setAiSuggestingDesc(item.id);
        try {
            const parent = item.parentId ? items.find((i: any) => i.id === item.parentId) : null;
            const costType = costTypes.find((ct: any) => ct.id === item.costTypeId);
            const res = await fetch("/api/ai-estimate/suggest", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    mode: "description",
                    itemName: item.name,
                    parentName: parent?.name,
                    projectName: context.name,
                    costType: costType?.name || item.type,
                }),
            });
            if (res.ok) {
                const data = await res.json();
                if (data.description) {
                    updateItem(itemIndex, "description", data.description);
                    toast.success("AI description added");
                }
            }
        } catch (err) {
            console.error("[AI Suggest] Description error:", err);
        } finally {
            setAiSuggestingDesc(null);
        }
    }

    // AI sub-item suggestions
    async function suggestSubitems(parentIndex: number) {
        const parent = items[parentIndex];
        if (!parent?.name?.trim() || aiSuggestingSubitems === parent.id) return;
        setAiSuggestingSubitems(parent.id);
        try {
            const res = await fetch("/api/ai-estimate/suggest", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    mode: "subitems",
                    itemName: parent.name,
                    projectName: context.name,
                    existingItems: items.filter((i: any) => i.parentId === parent.id),
                }),
            });
            if (res.ok) {
                const data = await res.json();
                if (data.suggestions?.length) {
                    setAiSubitemSuggestions(data.suggestions);
                    setShowSubitemSuggestions(parent.id);
                    // Pre-select all by default
                    setSelectedSuggestionIndices(new Set(data.suggestions.map((_: any, i: number) => i)));
                } else {
                    toast.info("No suggestions for this item");
                }
            }
        } catch (err) {
            console.error("[AI Suggest] Sub-items error:", err);
            toast.error("Failed to get AI suggestions");
        } finally {
            setAiSuggestingSubitems(null);
        }
    }

    function dismissSubitemSuggestions() {
        setShowSubitemSuggestions(null);
        setAiSubitemSuggestions([]);
        setSelectedSuggestionIndices(new Set());
    }

    function acceptSubitemSuggestions(parentId: string, suggestions: any[]) {
        const typeMap: Record<string, string> = {};
        for (const ct of costTypes) typeMap[ct.name] = ct.id;
        const newItems = suggestions.map((s: any) => ({
            id: generateId(),
            name: s.name,
            description: s.description || "",
            type: s.costType || "Material",
            quantity: 1,
            baseCost: 0,
            markupPercent: 25,
            unitCost: 0,
            total: 0,
            parentId,
            costCodeId: null,
            costTypeId: typeMap[s.costType] || null,
        }));
        setItems([...items, ...newItems]);
        setShowSubitemSuggestions(null);
        setAiSubitemSuggestions([]);
        setSelectedSuggestionIndices(new Set());
        toast.success(`Added ${newItems.length} sub-item${newItems.length !== 1 ? "s" : ""}`);
    }

    useEffect(() => {
        getEstimateTemplates().then(setAssemblies).catch((err) => console.error("[EstimateEditor] Failed to load templates:", err));
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
            .catch((err) => console.error("[EstimateEditor] Failed to load cost codes:", err));
        fetch('/api/cost-types?active=true')
            .then(res => res.json())
            .then(data => { if (Array.isArray(data)) setCostTypes(data); })
            .catch((err) => console.error("[EstimateEditor] Failed to load cost types:", err));
    }, []);

    // Subtotal from leaf items only (sections would double-count)
    const subtotal = items.reduce((acc, item) => {
        if (item.parentId) return acc + rm((parseFloat(item.quantity) || 0) * (parseFloat(item.unitCost) || 0));
        if (!items.some((i: any) => i.parentId === item.id)) return acc + rm((parseFloat(item.quantity) || 0) * (parseFloat(item.unitCost) || 0));
        return acc;
    }, 0);
    const taxRate = defaultTax ? defaultTax.rate / 100 : 0.088;
    const taxName = defaultTax ? `${defaultTax.name} (${defaultTax.rate}%)` : "Estimated Tax (8.8%)";
    const processingFee = processingFeeMarkup > 0 ? rm(subtotal * (processingFeeMarkup / 100)) : 0;
    const tax = rm(subtotal * taxRate);
    const total = rm(subtotal + tax + processingFee);

    // Auto-recalculate percentage-based milestones when total changes
    useEffect(() => {
        setPaymentSchedules(prev => {
            if (prev.length === 0) return prev;
            const updated = prev.map(s => {
                const pct = parseFloat(s.percentage) || 0;
                if (pct > 0 && s.status !== "Paid") {
                    return { ...s, amount: String(rm(total * (pct / 100))) };
                }
                return s;
            });
            const changed = updated.some((s, i) => s.amount !== prev[i].amount);
            return changed ? updated : prev;
        });
    }, [total]);

    // Internal margin calculations
    // Base cost from leaf items only (sections would double-count)
    const totalBaseCost = items.reduce((acc, item) => {
        const rate = (item.budgetRate !== null && item.budgetRate !== undefined && item.budgetRate !== "")
            ? parseFloat(item.budgetRate)
            : (parseFloat(item.baseCost) || 0);
        const qty = item.budgetQuantity ?? (parseFloat(item.quantity) || 0);
        if (item.parentId) return acc + (qty * rate);
        if (!items.some((i: any) => i.parentId === item.id)) return acc + (qty * rate);
        return acc;
    }, 0);
    const totalMarkup = subtotal - totalBaseCost;
    const profitMargin = subtotal > 0 ? ((totalMarkup / subtotal) * 100) : 0;

    async function handleSave() {
        captureHistory(new Date().toLocaleString());
        setIsSaving(true);
        // Recompute section header totals from children before saving
        const childTotals = new Map<string, number>();
        for (const item of items) {
            if (item.parentId) {
                childTotals.set(item.parentId, (childTotals.get(item.parentId) || 0) + rm((parseFloat(item.quantity) || 0) * (parseFloat(item.unitCost) || 0)));
            }
        }
        const mappedItems = items.map((item, index) => {
            const isSection = !item.parentId && items.some((i: any) => i.parentId === item.id);
            const computedTotal = isSection
                ? (childTotals.get(item.id) || 0)
                : rm((parseFloat(item.quantity) || 0) * (parseFloat(item.unitCost) || 0));
            return { ...item, order: index, total: computedTotal, ...(isSection ? { unitCost: computedTotal } : {}) };
        });
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
            const result = await deleteEstimate(initialEstimate.id);
            if (!result.success) {
                toast.error(result.error || "Failed to delete estimate");
                return;
            }
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

    function captureHistory(label: string) {
        setHistory(prev => [{ ts: Date.now(), label, snapshot: JSON.parse(JSON.stringify(items)) }, ...prev.slice(0, 49)]);
    }

    function revertToHistory(entry: { ts: number; label: string; snapshot: any[] }) {
        setItems(entry.snapshot);
        setExpandedHistoryTs(null);
        toast.success(`Reverted to ${entry.label}`);
    }

    function diffSnapshots(prev: any[], curr: any[]) {
        const prevMap = new Map(prev.map(i => [i.id, i]));
        const currMap = new Map(curr.map(i => [i.id, i]));
        const added   = curr.filter(i => !prevMap.has(i.id) && i.name?.trim());
        const removed = prev.filter(i => !currMap.has(i.id) && i.name?.trim());
        const changed = curr.filter(i => {
            const p = prevMap.get(i.id);
            if (!p || !i.name?.trim()) return false;
            return p.name !== i.name || String(p.quantity) !== String(i.quantity) || String(p.unitCost) !== String(i.unitCost);
        });
        return { added, removed, changed };
    }

    function makeBlankItem(parentId: string | null) {
        return {
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
            costTypeId: null,
        };
    }

    function addItem(parentId: string | null = null) {
        if (parentId) {
            // Insert after the last existing child of this parent
            const lastChildIdx = items.reduce((last, it, idx) => it.parentId === parentId ? idx : last, -1);
            const insertAt = lastChildIdx >= 0 ? lastChildIdx + 1 : (items.findIndex(i => i.id === parentId) + 1);
            const newItems = [...items];
            newItems.splice(insertAt, 0, makeBlankItem(parentId));
            setItems(newItems);
        } else {
            setItems([...items, makeBlankItem(null)]);
        }
    }

    /** "Add Sub-item": carry parent description into new sub-item, clear parent description */
    function addSubItem(parentIndex: number) {
        const parent = items[parentIndex];
        const desc = parent.description || "";
        const newItems = [...items];
        newItems[parentIndex] = { ...parent, description: "" };
        const lastChildIdx = newItems.reduce((last, it, idx) => it.parentId === parent.id ? idx : last, parentIndex);
        const newSub = { ...makeBlankItem(parent.id), description: desc };
        newItems.splice(lastChildIdx + 1, 0, newSub);
        setItems(newItems);
    }

    /** Insert a blank item right after `afterIndex` with the given parentId */
    function addItemAfter(afterIndex: number, parentId: string | null) {
        const newItems = [...items];
        newItems.splice(afterIndex + 1, 0, makeBlankItem(parentId));
        setItems(newItems);
    }

    /** Insert a new category (+ one blank sub-item) right after `afterIndex` */
    function addCategoryAfter(afterIndex: number) {
        const catId = generateId();
        const newCat = {
            id: catId, name: "", description: "", type: "Section",
            quantity: 1, baseCost: 0, markupPercent: 25, unitCost: 0, total: 0,
            parentId: null, costCodeId: null, costTypeId: null, isSection: true,
        };
        const newItems = [...items];
        newItems.splice(afterIndex + 1, 0, newCat, makeBlankItem(catId));
        setItems(newItems);
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

                // Close modal and update UI immediately — don't wait for save
                setItems(newItems);
                if (data.paymentMilestones && data.paymentMilestones.length > 0) {
                    setPaymentSchedules(newSchedules);
                }
                setShowAiModal(false);
                setAiPrompt("");
                toast.success(`AI generated ${data.count} items (est. ${formatCurrency(Number(data.totalEstimate || 0))})`);

                // Auto-save in background — set isSaving to block concurrent blur-triggered save
                setIsSaving(true);
                try {
                    // Recompute section header totals from children before saving
                    const aiChildTotals = new Map<string, number>();
                    for (const item of newItems) {
                        if (item.parentId) {
                            aiChildTotals.set(item.parentId, (aiChildTotals.get(item.parentId) || 0) + rm((parseFloat(item.quantity) || 0) * (parseFloat(item.unitCost) || 0)));
                        }
                    }
                    const mappedItems = newItems.map((item: any, index: number) => {
                        const isSect = !item.parentId && newItems.some((i: any) => i.parentId === item.id);
                        const ct = isSect ? (aiChildTotals.get(item.id) || 0) : rm((parseFloat(item.quantity) || 0) * (parseFloat(item.unitCost) || 0));
                        return { ...item, order: index, total: ct, ...(isSect ? { unitCost: ct } : {}) };
                    });
                    const mappedSchedules = newSchedules.map((schedule, index) => ({
                        ...schedule,
                        order: index
                    }));
                    // Subtotal from leaf items only (sections would double-count)
                    const newSubtotal = newItems.reduce((acc: number, item: any) => {
                        if (item.parentId) return acc + rm((parseFloat(item.quantity) || 0) * (parseFloat(item.unitCost) || 0));
                        if (!newItems.some((i: any) => i.parentId === item.id)) return acc + rm((parseFloat(item.quantity) || 0) * (parseFloat(item.unitCost) || 0));
                        return acc;
                    }, 0);
                    const newTotal = rm(newSubtotal + rm(newSubtotal * taxRate));
                    await saveEstimate(initialEstimate.id, context.id, context.type, {
                        title, code, status, totalAmount: newTotal, paymentSchedules: mappedSchedules
                    }, mappedItems);
                    toast.success("Estimate auto-saved");
                    router.refresh();
                } catch (saveErr) {
                    console.error("Auto-save after AI generate failed:", saveErr);
                    toast.error("Items added — but auto-save failed. Click Save to persist.");
                } finally {
                    setIsSaving(false);
                }
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

    async function handleLinkPO(itemId: string) {
        if (context.type !== "project") return;
        setPOLinkItemId(itemId);
        setLoadingPOs(true);
        try {
            const pos = await getProjectPurchaseOrdersForLinking(context.id);
            setProjectPOs(pos);
        } catch { toast.error("Failed to load purchase orders"); }
        finally { setLoadingPOs(false); }
    }

    async function handleSelectPO(itemId: string, po: any) {
        try {
            await linkPOToEstimateItem(itemId, po.id);
            const idx = items.findIndex((i: any) => i.id === itemId);
            if (idx >= 0) updateItem(idx, "purchaseOrderId", po.id);
            if (idx >= 0) updateItem(idx, "purchaseOrder", po);
            toast.success(`Linked ${po.code}`);
        } catch (err: any) { toast.error(err.message); }
        finally { setPOLinkItemId(null); }
    }

    async function handleUnlinkPO(itemId: string) {
        try {
            await unlinkPOFromEstimateItem(itemId);
            const idx = items.findIndex((i: any) => i.id === itemId);
            if (idx >= 0) { updateItem(idx, "purchaseOrderId", null); updateItem(idx, "purchaseOrder", null); }
            toast.success("PO unlinked");
        } catch (err: any) { toast.error(err.message); }
    }

    function handlePOCreated(itemId: string, po: any) {
        const idx = items.findIndex((i: any) => i.id === itemId);
        if (idx >= 0) { updateItem(idx, "purchaseOrderId", po.id); updateItem(idx, "purchaseOrder", po); }
    }

    async function handleAiFill(itemId?: string) {
        const leafItems = items.filter(item => {
            if (!item.parentId && items.some((i: any) => i.parentId === item.id)) return false;
            return true;
        });
        const targetItems = itemId
            ? leafItems.filter(i => i.id === itemId)
            : leafItems.filter(i => internalBudget({ budgetQuantity: i.budgetQuantity, quantity: parseFloat(i.quantity) || 0, budgetRate: i.budgetRate, baseCost: i.baseCost }) == null);

        if (targetItems.length === 0) {
            toast.info("All items already have budgets");
            return;
        }

        setIsAiFilling(true);
        if (itemId) setAiFillItemId(itemId);

        try {
            const res = await fetch("/api/ai-estimate/budget-fill", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    items: targetItems.map(i => ({
                        id: i.id,
                        name: i.name || "",
                        description: i.description || "",
                        type: i.type || "Material",
                        quantity: parseFloat(i.quantity) || 1,
                        unitCost: parseFloat(i.unitCost) || 0,
                        budgetRate: i.budgetRate,
                        budgetUnit: i.budgetUnit,
                    })),
                    projectContext: `${context.name} (${context.type})`,
                    location: context.location || "Vancouver, WA",
                }),
            });

            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || "AI budget fill failed");
            }

            const { suggestions } = await res.json();
            let filled = 0;
            setItems(prev => {
                const next = [...prev];
                for (const s of suggestions) {
                    const idx = next.findIndex((i: any) => i.id === s.id);
                    if (idx < 0) continue;
                    const rate = parseFloat(s.budgetRate) || 0;
                    const margin = parseFloat(s.marginPercent) || 25;
                    next[idx] = {
                        ...next[idx],
                        budgetRate: rate > 0 ? String(rate) : null,
                        baseCost: rate > 0 ? String(rate) : null,
                        budgetUnit: s.budgetUnit || next[idx].budgetUnit,
                        budgetQuantity: s.budgetQuantity || next[idx].budgetQuantity,
                        markupPercent: margin,
                        unitCost: sellFromMargin(rate, margin).toFixed(2),
                    };
                    filled++;
                }
                return next;
            });

            toast.success(`AI filled budgets for ${filled} item${filled !== 1 ? "s" : ""} — review and adjust`);
        } catch (err: any) {
            toast.error(err.message || "AI budget fill failed");
        } finally {
            setIsAiFilling(false);
            setAiFillItemId(null);
        }
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
            newSchedules[index].amount = String(rm(total * (pct / 100)));
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
        const srcIdx = result.source.index;
        const dstIdx = result.destination.index;
        if (srcIdx === dstIdx) return;

        const dragged = items[srcIdx];
        const draggedIsCategory = !dragged.parentId && sectionIds.has(dragged.id);

        if (draggedIsCategory) {
            // Move the category header and all its children as a block
            const children = items.filter(i => i.parentId === dragged.id);
            const block = [dragged, ...children];
            const withoutBlock = items.filter(i => i.id !== dragged.id && i.parentId !== dragged.id);
            const adjustedDst = Math.max(0, Math.min(dstIdx - (srcIdx < dstIdx ? block.length - 1 : 0), withoutBlock.length));
            withoutBlock.splice(adjustedDst, 0, ...block);
            setItems(withoutBlock);
        } else {
            const newItems = Array.from(items);
            newItems.splice(srcIdx, 1);
            newItems.splice(dstIdx, 0, dragged);

            // Recompute parentId for the dragged item based on its new neighbours
            const itemBefore = dstIdx > 0 ? newItems[dstIdx - 1] : null;
            let newParentId: string | null = dragged.parentId;
            if (!itemBefore) {
                newParentId = null;
            } else if (!itemBefore.parentId && newItems.some(i => i !== newItems[dstIdx] && i.parentId === itemBefore.id)) {
                // Dropped right after a category header → become its child
                newParentId = itemBefore.id;
            } else if (itemBefore.parentId) {
                // Dropped after a sub-item → join that category
                newParentId = itemBefore.parentId;
            } else {
                newParentId = null;
            }
            newItems[dstIdx] = { ...newItems[dstIdx], parentId: newParentId };
            setItems(newItems);
        }
    }

    return (
        <div
            className="flex flex-col h-full bg-slate-50"
            onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node) && !showTemplateModal && !showAiModal && !showSendModal && !showMoreMenu && !isSaving) {
                    handleSave();
                }
            }}
        >
            {/* Top Navigation / Action Bar */}
            <div className="bg-white border-b border-hui-border px-4 py-3 flex items-center justify-between shadow-sm z-10 sticky top-0">
                <div className="flex items-center gap-3">
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
                            className={`px-3 py-1 text-xs font-medium rounded transition ${viewMode === "internal" ? "bg-indigo-50 text-indigo-800 shadow-sm border border-indigo-200" : "text-slate-500 hover:text-slate-700"}`}
                        >Internal</button>
                    </div>

                    <div className="h-4 w-px bg-hui-border"></div>

                    {/* More dropdown for secondary actions */}
                    <div className="relative">
                        <button
                            onClick={() => setShowMoreMenu(v => !v)}
                            className="hui-btn hui-btn-secondary px-2.5"
                            title="More actions"
                        >
                            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="12" cy="19" r="1.5" /></svg>
                        </button>
                        {showMoreMenu && (
                            <>
                                <div className="fixed inset-0 z-40" onClick={() => setShowMoreMenu(false)} />
                                <div className="absolute right-0 top-full mt-1 w-56 bg-white rounded-lg shadow-xl border border-hui-border z-50 py-1 text-sm">
                                    {/* AI Tools section */}
                                    <div className="px-4 py-1 text-[10px] font-semibold text-hui-textMuted uppercase tracking-wider">AI Tools</div>
                                    <button
                                        onClick={() => { setShowAiModal(true); setShowMoreMenu(false); }}
                                        className="w-full text-left px-4 py-2.5 hover:bg-purple-50 flex items-center gap-2.5 text-purple-700"
                                    >
                                        <svg className="w-4 h-4 text-purple-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" /></svg>
                                        AI Generate
                                    </button>
                                    <button
                                        onClick={() => { handleHistoricalPricing(); setShowMoreMenu(false); }}
                                        disabled={isLoadingHistorical}
                                        className="w-full text-left px-4 py-2.5 hover:bg-teal-50 flex items-center gap-2.5 text-teal-700 disabled:opacity-50"
                                    >
                                        <svg className="w-4 h-4 text-teal-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
                                        {isLoadingHistorical ? "Analyzing..." : "Historical Pricing"}
                                    </button>
                                    {viewMode === "internal" && (
                                        <button
                                            onClick={() => { handleAiFill(); setShowMoreMenu(false); }}
                                            disabled={isAiFilling}
                                            className="w-full text-left px-4 py-2.5 hover:bg-indigo-50 flex items-center gap-2.5 text-indigo-700 disabled:opacity-50"
                                        >
                                            <svg className={`w-4 h-4 text-indigo-500 ${isAiFilling ? "animate-pulse" : ""}`} viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61z" /></svg>
                                            {isAiFilling ? "Filling budgets..." : "AI Fill Budgets"}
                                        </button>
                                    )}
                                    <button
                                        onClick={() => { setShowSidebar(v => !v); setShowMoreMenu(false); }}
                                        className="w-full text-left px-4 py-2.5 hover:bg-slate-50 flex items-center gap-2.5 text-hui-textMain"
                                    >
                                        <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h7" /></svg>
                                        {showSidebar ? "Hide Sidebar" : "Show Sidebar"}
                                    </button>
                                    <div className="border-t border-hui-border my-1" />
                                    <button
                                        onClick={() => { window.open(`/portal/estimates/${initialEstimate.id}`, '_blank'); setShowMoreMenu(false); }}
                                        className="w-full text-left px-4 py-2.5 hover:bg-slate-50 flex items-center gap-2.5 text-hui-textMain"
                                    >
                                        <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                                        Customer Portal
                                    </button>
                                    <button
                                        onClick={() => { window.open(`/portal/estimates/${initialEstimate.id}`, '_blank'); setShowMoreMenu(false); }}
                                        className="w-full text-left px-4 py-2.5 hover:bg-slate-50 flex items-center gap-2.5 text-hui-textMain"
                                    >
                                        <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg>
                                        Preview / Download PDF
                                    </button>
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
                        onClick={() => {
                            const unpaidSchedules = paymentSchedules.filter(s => s.status !== "Paid");
                            if (unpaidSchedules.length > 0) {
                                const paidSum = paymentSchedules.filter(s => s.status === "Paid").reduce((sum, s) => sum + (parseFloat(s.amount) || 0), 0);
                                const milestoneSum = paymentSchedules.reduce((sum, s) => sum + (parseFloat(s.amount) || 0), 0);
                                const remaining = rm(total - paidSum);
                                const unpaidSum = rm(milestoneSum - paidSum);
                                if (Math.abs(unpaidSum - remaining) > 0.01) {
                                    toast.error(`Payment milestones total $${milestoneSum.toFixed(2)} but estimate total is $${total.toFixed(2)}. Please adjust milestones.`);
                                    return;
                                }
                            }
                            setShowSendModal(true);
                        }}
                        className="hui-btn hui-btn-green flex items-center gap-2"
                    >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" /></svg>
                        {initialEstimate.sentAt ? "Resend" : "Send"}
                    </button>
                    <button
                        onClick={handleSave}
                        disabled={isSaving}
                        className="hui-btn hui-btn-primary disabled:opacity-50"
                    >
                        {isSaving ? "Saving..." : "Save"}
                    </button>
                </div>
            </div>

            {/* Selected Items Action Bar + Insert Assembly */}
            <div className="bg-amber-50 border-b border-amber-200 px-6 py-2 flex items-center gap-3 text-sm">
                {selectedItemIds.length > 0 ? (
                    <>
                        <span className="font-medium text-amber-800">{selectedItemIds.length} item{selectedItemIds.length > 1 ? 's' : ''} selected</span>
                        <div className="h-4 w-px bg-amber-300"></div>
                        <button onClick={async () => { await bulkUpdateItemApproval(selectedItemIds, "approved"); setItems(items.map(i => selectedItemIds.includes(i.id) ? { ...i, approvalStatus: "approved" } : i)); toast.success(`${selectedItemIds.length} items approved`); }} className="hui-btn hui-btn-secondary text-xs py-1 px-3 border-green-300 text-green-800 hover:bg-green-100 flex items-center gap-1.5">
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                            Approve All
                        </button>
                        <button onClick={async () => { await bulkUpdateItemApproval(selectedItemIds, "rejected"); setItems(items.map(i => selectedItemIds.includes(i.id) ? { ...i, approvalStatus: "rejected" } : i)); toast.success(`${selectedItemIds.length} items rejected`); }} className="hui-btn hui-btn-secondary text-xs py-1 px-3 border-red-300 text-red-800 hover:bg-red-100 flex items-center gap-1.5">
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                            Reject All
                        </button>
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
                                            <button onClick={(e) => handleDeleteAssembly(a.id, e)} className="text-slate-300 hover:text-red-500 transition p-1" title="Delete assembly">
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
                            <div className="h-1.5 w-full bg-slate-800"></div>
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
                                {sectionIds.size > 0 && (
                                    <div className="flex justify-end px-8 pt-3 pb-1">
                                        <button
                                            onClick={() => {
                                                if (collapsedSections.size === sectionIds.size) {
                                                    setCollapsedSections(new Set());
                                                } else {
                                                    setCollapsedSections(new Set(sectionIds));
                                                }
                                            }}
                                            className="text-xs text-slate-400 hover:text-slate-600 font-medium flex items-center gap-1 transition"
                                        >
                                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                {collapsedSections.size === sectionIds.size
                                                    ? <path d="M7 10l5 5 5-5" />
                                                    : <path d="M7 14l5-5 5 5" />
                                                }
                                            </svg>
                                            {collapsedSections.size === sectionIds.size ? "Expand All" : "Collapse All"}
                                        </button>
                                    </div>
                                )}
                                <div className="flex items-center gap-1 text-[11px] font-bold text-slate-400 bg-slate-50/80 border-b border-slate-100 px-4 py-3 uppercase tracking-wider">
                                <div className="w-6"></div>
                                <div className="w-6 pt-0.5">
                                    <input
                                        type="checkbox"
                                        checked={items.length > 0 && selectedItemIds.length === items.length}
                                        onChange={(e) => setSelectedItemIds(e.target.checked ? items.map(i => i.id) : [])}
                                        className="rounded border-slate-300 text-amber-600 focus:ring-amber-500"
                                    />
                                </div>
                                <div className="flex-1">Item</div>
                                <div className="w-20 text-right">Qty</div>
                                <div className="w-28 text-right">{viewMode === "internal" ? "Sell Price" : "Unit Cost"}</div>
                                <div className="w-28 text-right">Total</div>
                                <div className="w-24 text-right">Approval</div>
                            </div>

                            <DragDropContext onDragEnd={onDragEnd}>
                                <Droppable droppableId="items-list">
                                    {(provided) => (
                                        <div {...provided.droppableProps} ref={provided.innerRef} className="divide-y divide-slate-100">
                                            {items.map((item, index) => {
                                                const isSubItem = !!item.parentId;
                                                const isSection = !item.parentId && sectionIds.has(item.id);
                                                // Hide children of collapsed sections
                                                if (isSubItem && collapsedSections.has(item.parentId)) return null;
                                                const sectionTotal = isSection ? (sectionTotals.get(item.id) || 0) : 0;
                                                const itemTotal = (parseFloat(item.quantity) || 0) * (parseFloat(item.unitCost) || 0);
                                                const isCollapsed = isSection && collapsedSections.has(item.id);

                                                // ── Section header row ──────────────────────────────────────
                                                if (isSection) {
                                                    return (
                                                        <Draggable key={item.id} draggableId={item.id} index={index}>
                                                            {(provided, snapshot) => (
                                                                <div ref={provided.innerRef} {...provided.draggableProps}
                                                                    className={`flex items-center px-4 py-2.5 bg-slate-100 border-l-4 border-hui-primary group transition ${snapshot.isDragging ? "shadow-lg z-50" : ""}`}
                                                                >
                                                                    <div {...provided.dragHandleProps} className="w-8 flex items-center justify-center text-slate-400 hover:text-slate-600 cursor-grab">
                                                                        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4 5a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm0 6a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm5-6a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm0 6a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm5-6a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm0 6a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z" /></svg>
                                                                    </div>
                                                                    <button onClick={() => setCollapsedSections(prev => { const n = new Set(prev); n.has(item.id) ? n.delete(item.id) : n.add(item.id); return n; })}
                                                                        className="w-6 h-6 flex items-center justify-center rounded hover:bg-slate-200 transition mr-1 text-slate-500 flex-shrink-0"
                                                                    >
                                                                        <svg className={`w-3.5 h-3.5 transition-transform ${isCollapsed ? "-rotate-90" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                                                                        </svg>
                                                                    </button>
                                                                    <div className="w-6 mr-1">
                                                                        <input type="checkbox" checked={selectedItemIds.includes(item.id)}
                                                                            onChange={e => { if (e.target.checked) setSelectedItemIds([...selectedItemIds, item.id]); else setSelectedItemIds(selectedItemIds.filter(id => id !== item.id)); }}
                                                                            className="rounded border-slate-300 text-amber-600 focus:ring-amber-500"
                                                                        />
                                                                    </div>
                                                                    <div className="flex-1 flex flex-col">
                                                                        <input type="text" value={item.name} onChange={e => updateItem(index, "name", e.target.value)}
                                                                            placeholder="Category name"
                                                                            className="w-full bg-transparent focus:outline-none focus:bg-white focus:ring-1 ring-hui-border rounded px-2 py-0.5 font-semibold text-sm text-hui-textMain"
                                                                        />
                                                                        <div className="flex items-center gap-3 mt-0.5 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto transition-opacity duration-150">
                                                                            <button onClick={() => addSubItem(index)} className="text-[10px] text-hui-primary hover:text-hui-primaryHover font-medium focus-visible:opacity-100">+ Add Sub-item</button>
                                                                            <button onClick={() => addCategoryAfter(index + items.filter(i => i.parentId === item.id).length)} className="text-[10px] text-slate-400 hover:text-slate-600 font-medium focus-visible:opacity-100">+ Add Category Below</button>
                                                                        </div>
                                                                    </div>
                                                                    <div className="flex items-center gap-3 ml-auto">
                                                                        {isCollapsed && <span className="text-xs text-slate-400">{items.filter((i: any) => i.parentId === item.id).length} items</span>}
                                                                        <span className="text-sm font-semibold text-slate-700 w-28 text-right">{formatCurrency(sectionTotal)}</span>
                                                                        <button onClick={() => removeItem(index)} className="w-7 h-7 flex items-center justify-center rounded text-slate-300 hover:text-red-500 hover:bg-red-50 transition opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto">
                                                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                                                                        </button>
                                                                    </div>
                                                                </div>
                                                            )}
                                                        </Draggable>
                                                    );
                                                }

                                                // ── Regular item row ────────────────────────────────────────
                                                return (
                                                    <Draggable key={item.id} draggableId={item.id} index={index}>
                                                        {(provided, snapshot) => (<>
                                                            <div
                                                                ref={provided.innerRef}
                                                                {...provided.draggableProps}
                                                                className={`px-4 py-2 bg-white group hover:bg-slate-50/80 transition ${snapshot.isDragging ? "shadow-lg border-l-2 border-hui-primary z-50 ring-1 ring-hui-primary/20" : isSubItem ? "ml-6 border-l border-slate-200 bg-slate-50/30" : "border-l-2 border-transparent"}`}
                                                            >
                                                                {/* ── Tier 1: Name + Numbers ── */}
                                                                <div className="flex items-center gap-1">
                                                                    <div {...provided.dragHandleProps} className="w-6 flex items-center justify-center text-slate-300 hover:text-hui-textMuted cursor-grab flex-shrink-0">
                                                                        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4 5a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm0 6a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm5-6a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm0 6a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm5-6a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm0 6a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z" /></svg>
                                                                    </div>
                                                                    <div className="w-6 flex-shrink-0">
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
                                                                    <input
                                                                        type="text"
                                                                        value={item.name}
                                                                        onChange={e => updateItem(index, "name", e.target.value)}
                                                                        placeholder="Item name"
                                                                        className={`flex-1 min-w-0 bg-transparent focus:outline-none focus:bg-white focus:ring-1 ring-hui-border rounded px-2 py-1 transition text-sm ${isSubItem ? 'text-hui-textMuted' : 'font-medium text-hui-textMain'}`}
                                                                    />
                                                                    <div className="w-20 px-2 text-right flex-shrink-0">
                                                                        <input
                                                                            type="number"
                                                                            value={item.quantity}
                                                                            onChange={e => updateItem(index, "quantity", e.target.value)}
                                                                            className="w-full bg-transparent focus:outline-none focus:bg-white focus:ring-1 ring-slate-200 rounded px-2 py-1 text-right hover:bg-slate-50 transition text-sm font-medium text-slate-700"
                                                                        />
                                                                    </div>
                                                                    {(() => { const isLocked = viewMode === "internal" && !!(item.budgetRate ?? item.baseCost); return (
                                                                    <div className="w-28 px-2 flex items-center justify-end flex-shrink-0">
                                                                        <span className={`text-sm flex-shrink-0 ${isLocked ? "text-slate-300" : "text-slate-400"}`}>$</span>
                                                                        <input
                                                                            type="number"
                                                                            value={item.unitCost}
                                                                            onChange={e => updateItem(index, "unitCost", e.target.value)}
                                                                            readOnly={isLocked}
                                                                            aria-label="Unit cost"
                                                                            className={`w-20 focus:outline-none rounded px-1 py-1 text-right transition text-sm font-medium ${isLocked ? "bg-transparent text-slate-400 cursor-default" : "bg-transparent focus:bg-white focus:ring-1 ring-slate-200 hover:bg-slate-50 text-slate-700"}`}
                                                                        />
                                                                    </div>
                                                                    ); })()}
                                                                    <div className="w-28 px-2 text-right font-semibold text-slate-800 text-sm flex-shrink-0">
                                                                        {formatCurrency(itemTotal)}
                                                                    </div>
                                                                    <div className="w-24 flex items-center justify-end gap-0.5 flex-shrink-0">
                                                                        {item.approvalStatus === "approved" ? (
                                                                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-green-50 text-green-700 border border-green-200 cursor-pointer" onClick={async () => { await updateItemApproval(item.id, null); updateItem(index, "approvalStatus", null); }}>
                                                                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                                                                                Approved
                                                                            </span>
                                                                        ) : item.approvalStatus === "rejected" ? (
                                                                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-red-50 text-red-700 border border-red-200 cursor-pointer" onClick={async () => { await updateItemApproval(item.id, null); updateItem(index, "approvalStatus", null); }}>
                                                                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                                                                                Rejected
                                                                            </span>
                                                                        ) : (
                                                                            <span className="opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto transition flex gap-0.5">
                                                                                <button onClick={async () => { await updateItemApproval(item.id, "approved"); updateItem(index, "approvalStatus", "approved"); toast.success("Item approved"); }} className="p-1 rounded hover:bg-green-50 text-slate-400 hover:text-green-600 transition focus-visible:opacity-100 focus-visible:pointer-events-auto" title="Approve">
                                                                                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                                                                                </button>
                                                                                <button onClick={async () => { await updateItemApproval(item.id, "rejected"); updateItem(index, "approvalStatus", "rejected"); toast.success("Item rejected"); }} className="p-1 rounded hover:bg-red-50 text-slate-400 hover:text-red-500 transition focus-visible:opacity-100 focus-visible:pointer-events-auto" title="Reject">
                                                                                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                                                                                </button>
                                                                            </span>
                                                                        )}
                                                                        <button onClick={() => removeItem(index)} className="opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto text-slate-300 hover:text-red-500 hover:bg-red-50 rounded p-1 transition">
                                                                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
                                                                        </button>
                                                                    </div>
                                                                </div>
                                                                {/* ── Tier 2: Description + Metadata (full width) ── */}
                                                                <div className={`${isSubItem ? 'pl-8' : 'pl-14'} pr-2 mt-0.5`}>
                                                                    <div className="flex items-start gap-1">
                                                                        <textarea
                                                                            ref={el => autoExpand(el)}
                                                                            value={item.description || ""}
                                                                            onChange={e => {
                                                                                updateItem(index, "description", e.target.value);
                                                                                autoExpand(e.target);
                                                                            }}
                                                                            onInput={e => autoExpand(e.target as HTMLTextAreaElement)}
                                                                            placeholder="Add description..."
                                                                            rows={1}
                                                                            className="flex-1 bg-transparent focus:outline-none focus:bg-white focus:ring-1 ring-hui-border rounded px-2 py-0.5 transition text-xs text-hui-textMuted resize-none overflow-hidden"
                                                                        />
                                                                        {item.name?.trim() && (
                                                                            <button
                                                                                onClick={() => suggestDescription(index)}
                                                                                disabled={aiSuggestingDesc === item.id}
                                                                                title="AI: suggest description"
                                                                                className="flex-shrink-0 mt-0.5 p-0.5 rounded text-amber-400 hover:text-amber-600 hover:bg-amber-50 transition disabled:opacity-50 disabled:animate-pulse opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto"
                                                                            >
                                                                                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2z"/></svg>
                                                                            </button>
                                                                        )}
                                                                    </div>
                                                                    {/* Phase/Type pills + action buttons — hover only */}
                                                                    <div className="flex items-center gap-2 mt-1 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto transition-opacity duration-150">
                                                                        <select
                                                                            value={item.costCodeId || ""}
                                                                            onChange={e => updateItem(index, "costCodeId", e.target.value || null)}
                                                                            className="bg-slate-100 hover:bg-slate-200 focus:bg-white focus:ring-1 ring-hui-border text-hui-textMuted text-[11px] rounded-full px-2.5 py-0.5 border-0 focus:outline-none cursor-pointer transition"
                                                                        >
                                                                            <option value="">Phase</option>
                                                                            {costCodes.map(cc => (
                                                                                <option key={cc.id} value={cc.id}>{cc.code}</option>
                                                                            ))}
                                                                        </select>
                                                                        <select
                                                                            value={item.costTypeId || ""}
                                                                            onChange={e => {
                                                                                updateItem(index, "costTypeId", e.target.value || null);
                                                                                const ct = costTypes.find(c => c.id === e.target.value);
                                                                                if (ct) updateItem(index, "type", ct.name);
                                                                            }}
                                                                            className={`hover:bg-slate-200 focus:bg-white focus:ring-1 ring-hui-border text-[11px] rounded-full px-2.5 py-0.5 border-0 focus:outline-none cursor-pointer transition ${
                                                                                costTypes.find(c => c.id === item.costTypeId)?.name === 'Allowance'
                                                                                    ? 'bg-amber-100 text-amber-700 font-semibold'
                                                                                    : 'bg-slate-100 text-hui-textMuted'
                                                                            }`}
                                                                        >
                                                                            <option value="">Type</option>
                                                                            {costTypes.map(ct => (
                                                                                <option key={ct.id} value={ct.id}>{ct.name}</option>
                                                                            ))}
                                                                        </select>
                                                                        <span className="w-px h-3 bg-slate-200"></span>
                                                                        {!isSubItem && (
                                                                            <button onClick={() => addSubItem(index)} className="text-[10px] text-hui-primary hover:text-hui-primaryHover font-medium">
                                                                                + Sub-item
                                                                            </button>
                                                                        )}
                                                                        {isSubItem && (
                                                                            <button onClick={() => addItemAfter(index, item.parentId)} className="text-[10px] text-hui-primary hover:text-hui-primaryHover font-medium">
                                                                                + Item Below
                                                                            </button>
                                                                        )}
                                                                        {!isSubItem && (
                                                                            <button onClick={() => addCategoryAfter(index)} className="text-[10px] text-slate-400 hover:text-slate-600 font-medium">
                                                                                + Category
                                                                            </button>
                                                                        )}
                                                                        {!isSubItem && item.name?.trim() && (
                                                                            <button
                                                                                onClick={() => suggestSubitems(index)}
                                                                                disabled={aiSuggestingSubitems === item.id}
                                                                                className="text-[10px] text-amber-500 hover:text-amber-700 font-medium flex items-center gap-0.5 disabled:opacity-50 disabled:animate-pulse"
                                                                            >
                                                                                <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2z"/></svg>
                                                                                {aiSuggestingSubitems === item.id ? "Thinking..." : "AI Sub-items"}
                                                                            </button>
                                                                        )}
                                                                    </div>
                                                                    {/* AI sub-item suggestions popover */}
                                                                    {showSubitemSuggestions === item.id && aiSubitemSuggestions.length > 0 && (
                                                                        <div className="mt-2 bg-amber-50 border border-amber-200 rounded-lg p-3 shadow-sm">
                                                                            <div className="flex items-center justify-between mb-2">
                                                                                <div className="flex items-center gap-2">
                                                                                    <span className="text-xs font-semibold text-amber-800">AI Suggested Sub-items</span>
                                                                                    <button
                                                                                        onClick={() => {
                                                                                            if (selectedSuggestionIndices.size === aiSubitemSuggestions.length) {
                                                                                                setSelectedSuggestionIndices(new Set());
                                                                                            } else {
                                                                                                setSelectedSuggestionIndices(new Set(aiSubitemSuggestions.map((_: any, i: number) => i)));
                                                                                            }
                                                                                        }}
                                                                                        className="text-[10px] text-amber-600 hover:text-amber-800 underline"
                                                                                    >
                                                                                        {selectedSuggestionIndices.size === aiSubitemSuggestions.length ? "Deselect all" : "Select all"}
                                                                                    </button>
                                                                                </div>
                                                                                <div className="flex gap-1">
                                                                                    <button
                                                                                        onClick={() => acceptSubitemSuggestions(item.id, aiSubitemSuggestions.filter((_: any, i: number) => selectedSuggestionIndices.has(i)))}
                                                                                        disabled={selectedSuggestionIndices.size === 0}
                                                                                        className="text-[10px] font-medium bg-amber-500 text-white px-2 py-0.5 rounded hover:bg-amber-600 transition disabled:opacity-40"
                                                                                    >
                                                                                        Add {selectedSuggestionIndices.size > 0 && selectedSuggestionIndices.size < aiSubitemSuggestions.length ? `${selectedSuggestionIndices.size} Selected` : "All"}
                                                                                    </button>
                                                                                    <button
                                                                                        onClick={dismissSubitemSuggestions}
                                                                                        className="text-[10px] font-medium text-amber-600 hover:text-amber-800 px-1"
                                                                                    >
                                                                                        Dismiss
                                                                                    </button>
                                                                                </div>
                                                                            </div>
                                                                            <div className="space-y-1">
                                                                                {aiSubitemSuggestions.map((s: any, si: number) => (
                                                                                    <div
                                                                                        key={si}
                                                                                        onClick={() => {
                                                                                            const next = new Set(selectedSuggestionIndices);
                                                                                            next.has(si) ? next.delete(si) : next.add(si);
                                                                                            setSelectedSuggestionIndices(next);
                                                                                        }}
                                                                                        className={`flex items-start gap-2 text-xs rounded px-2 py-1.5 border cursor-pointer transition ${
                                                                                            selectedSuggestionIndices.has(si)
                                                                                                ? "bg-amber-100 border-amber-300"
                                                                                                : "bg-white border-amber-100 opacity-60"
                                                                                        }`}
                                                                                    >
                                                                                        <input
                                                                                            type="checkbox"
                                                                                            checked={selectedSuggestionIndices.has(si)}
                                                                                            onChange={() => {}}
                                                                                            className="mt-0.5 flex-shrink-0 accent-amber-500"
                                                                                        />
                                                                                        <div className="flex-1 min-w-0">
                                                                                            <span className="font-medium text-slate-800">{s.name}</span>
                                                                                            {s.description && <p className="text-slate-500 mt-0.5 line-clamp-2">{s.description}</p>}
                                                                                        </div>
                                                                                        <span className="ml-1 text-[10px] text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded whitespace-nowrap flex-shrink-0">{s.costType}</span>
                                                                                    </div>
                                                                                ))}
                                                                            </div>
                                                                        </div>
                                                                    )}
                                                                </div>
                                                            </div>
                                                            {viewMode === "internal" && !isSection && (
                                                                <BudgetStrip
                                                                    item={item}
                                                                    index={index}
                                                                    updateItem={updateItem}
                                                                    contextType={context.type}
                                                                    onLinkPO={handleLinkPO}
                                                                    onCreatePO={(id) => setPOCreateItemId(id)}
                                                                    onUnlinkPO={handleUnlinkPO}
                                                                    onViewPO={(poId) => window.open(`/projects/${context.id}/purchase-orders/${poId}`, "_blank")}
                                                                    onAiFill={(id) => handleAiFill(id)}
                                                                    isAiFilling={isAiFilling && (aiFillItemId === item.id || aiFillItemId === null)}
                                                                />
                                                            )}
                                                        </>)}
                                                    </Draggable>
                                                );
                                            })}
                                            {provided.placeholder}
                                        </div>
                                    )}
                                </Droppable>
                            </DragDropContext>

                            <div className="p-4 px-8 border-t border-slate-100 bg-white flex items-center gap-4">
                                <button onClick={() => addItem(null)} className="text-sm font-semibold text-indigo-500 hover:text-indigo-600 flex items-center gap-2 transition group/btn">
                                    <span className="bg-indigo-50 text-indigo-500 group-hover/btn:bg-indigo-100 rounded p-1">
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14"/></svg>
                                    </span>
                                    Add New Item
                                </button>
                                <button onClick={() => addCategoryAfter(items.length - 1)} className="text-sm font-semibold text-slate-400 hover:text-slate-600 flex items-center gap-2 transition group/btn">
                                    <span className="bg-slate-50 text-slate-400 group-hover/btn:bg-slate-100 rounded p-1">
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14"/></svg>
                                    </span>
                                    Add New Category
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
                                                <button onClick={() => removePaymentSchedule(index)} className="text-slate-300 hover:text-red-500 hover:bg-red-50 rounded p-1.5 transition">
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
                                <div className="bg-indigo-50/60 border-t border-indigo-200 px-10 py-4 flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        <svg className="w-4 h-4 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
                                        <span className="text-xs font-semibold text-indigo-800 uppercase tracking-wider">Internal Margin Summary</span>
                                    </div>
                                    <div className="flex items-center gap-6 text-sm">
                                        <div className="text-center">
                                            <div className="text-[10px] text-indigo-600 font-semibold uppercase">Internal Budget</div>
                                            <div className="font-bold text-indigo-900">{formatCurrency(totalBaseCost)}</div>
                                        </div>
                                        <div className="text-center">
                                            <div className="text-[10px] text-indigo-600 font-semibold uppercase">Profit</div>
                                            <div className="font-bold text-indigo-900">{formatCurrency(totalMarkup)}</div>
                                        </div>
                                        <div className="text-center">
                                            <div className="text-[10px] text-indigo-600 font-semibold uppercase">Margin</div>
                                            <div className="font-bold text-indigo-900">{profitMargin.toFixed(1)}%</div>
                                        </div>
                                        <div className="text-center">
                                            <div className="text-[10px] text-indigo-600 font-semibold uppercase">Sell Total</div>
                                            <div className="font-bold text-indigo-900">{formatCurrency(subtotal)}</div>
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
                                                <button onClick={() => handleDeleteFile(f.id)} className="text-slate-400 hover:text-red-500 transition ml-2" title="Delete">
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
                        <button
                            onClick={() => setSidebarTab("comments")}
                            className={`flex-1 px-4 py-3 text-sm font-medium transition ${sidebarTab === "comments" ? "text-indigo-600 border-b-2 border-indigo-600" : "text-slate-500 hover:text-slate-700"}`}
                        >Comments</button>
                        <button
                            onClick={() => setSidebarTab("history")}
                            className={`flex-1 px-4 py-3 text-sm font-medium transition ${sidebarTab === "history" ? "text-indigo-600 border-b-2 border-indigo-600" : "text-slate-500 hover:text-slate-700"}`}
                        >History</button>
                    </div>

                    {sidebarTab === "overview" && (
                        <div className="p-4 space-y-3">
                            {/* Financials */}
                            <div>
                                <div className="flex items-center justify-between mb-1.5">
                                    <label className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Financials</label>
                                    {viewMode === "internal" && (() => {
                                        const leafItems = items.filter(item => {
                                            if (!item.parentId && items.some((i: any) => i.parentId === item.id)) return false;
                                            return true;
                                        });
                                        const budgeted = leafItems.filter(i => internalBudget({ budgetQuantity: i.budgetQuantity, quantity: parseFloat(i.quantity) || 0, budgetRate: i.budgetRate, baseCost: i.baseCost }) != null).length;
                                        const totalLeaf = leafItems.length;
                                        const allBudgeted = budgeted === totalLeaf;
                                        return (
                                            <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${allBudgeted ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
                                                {budgeted}/{totalLeaf} budgeted
                                            </span>
                                        );
                                    })()}
                                    {viewMode !== "internal" && (
                                        <span className="text-[11px] text-slate-400">
                                            {items.length} items{paymentSchedules.length > 0 && ` · ${paymentSchedules.length} milestones`}
                                        </span>
                                    )}
                                </div>
                                <div className="bg-slate-50 rounded-lg p-2.5 divide-y divide-slate-200">
                                    {viewMode === "internal" && (
                                        <div className="flex justify-between items-baseline pb-2">
                                            <span className="text-[10px] text-indigo-500 font-medium uppercase">Internal Budget</span>
                                            <span className="text-sm font-semibold text-indigo-700">{formatCurrency(totalBaseCost)}</span>
                                        </div>
                                    )}
                                    <div className="flex justify-between items-baseline py-2">
                                        <span className="text-[10px] text-slate-500 font-medium uppercase">{viewMode === "internal" ? "Sell Total" : "Subtotal"}</span>
                                        <span className="text-sm font-semibold text-slate-700">{formatCurrency(subtotal)}</span>
                                    </div>
                                    <div className="flex justify-between items-baseline py-2">
                                        <span className="text-[10px] text-indigo-500 font-medium uppercase">Total</span>
                                        <span className="text-sm font-bold text-indigo-700">{formatCurrency(total)}</span>
                                    </div>
                                    {viewMode === "internal" && (
                                        <div className="flex justify-between items-baseline pt-2">
                                            <span className={`text-[10px] font-medium uppercase ${profitMargin >= 20 ? "text-emerald-600" : profitMargin >= 10 ? "text-amber-600" : "text-red-600"}`}>Margin</span>
                                            <span className={`text-sm font-bold ${profitMargin >= 20 ? "text-emerald-700" : profitMargin >= 10 ? "text-amber-700" : "text-red-700"}`}>{profitMargin.toFixed(1)}% ({formatCurrency(totalMarkup)})</span>
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* Key Dates */}
                            <div>
                                <label className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1.5 block">Key Dates</label>
                                <div className="space-y-1 text-xs">
                                    <div className="flex justify-between">
                                        <span className="text-slate-500">Created</span>
                                        <span className="text-slate-700 font-medium">{new Date(initialEstimate.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                                    </div>
                                    {initialEstimate.sentAt && (
                                        <div className="flex justify-between">
                                            <span className="text-slate-500">Sent</span>
                                            <span className="text-slate-700 font-medium">{new Date(initialEstimate.sentAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                                        </div>
                                    )}
                                    {initialEstimate.viewedAt && (
                                        <div className="flex justify-between">
                                            <span className="text-slate-500">Viewed</span>
                                            <span className="text-slate-700 font-medium">{new Date(initialEstimate.viewedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
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
                                            <span className={`font-medium ${new Date(expirationDate) < new Date() ? 'text-red-600' : 'text-slate-700'}`}>{new Date(expirationDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* Client Info */}
                            <div>
                                <label className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1.5 block">Client</label>
                                <div className="bg-slate-50 rounded-lg px-2.5 py-2 space-y-0.5">
                                    <p className="text-xs font-semibold text-slate-800 truncate">{context.clientName}</p>
                                    {context.clientEmail && <p className="text-[11px] text-slate-500 truncate">{context.clientEmail}</p>}
                                    {context.location && <p className="text-[11px] text-slate-500 truncate">{context.location}</p>}
                                </div>
                            </div>

                            {/* Signature */}
                            {initialEstimate.signatureUrl && (
                                <div>
                                    <label className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1.5 block">Signature</label>
                                    <div className="bg-green-50 rounded-lg px-2.5 py-2 border border-green-200 flex items-center gap-2.5">
                                        <svg className="w-3.5 h-3.5 text-green-600 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                                        <span className="text-[11px] font-semibold text-green-700 truncate flex-1 min-w-0">Signed by {initialEstimate.approvedBy || 'Client'}</span>
                                        <img src={initialEstimate.signatureUrl} alt="Signature" className="max-h-10 max-w-[120px] object-contain rounded shrink-0" />
                                    </div>
                                </div>
                            )}
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

                    {sidebarTab === "comments" && (
                        <div className="flex-1 flex flex-col min-h-0">
                            <DocumentComments
                                documentType="estimate"
                                documentId={initialEstimate.id}
                                currentUserId={undefined}
                                currentUserName={undefined}
                                showClientTab={true}
                            />
                        </div>
                    )}

                    {sidebarTab === "history" && (
                        <div className="p-4 space-y-2 flex-1 overflow-y-auto">
                            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-3">Saved Snapshots</p>
                            {history.length === 0 ? (
                                <div className="text-center py-10">
                                    <svg className="w-8 h-8 text-slate-200 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                                    <p className="text-xs text-slate-400">No history yet. Save the estimate to create a snapshot.</p>
                                </div>
                            ) : (
                                history.map((entry) => {
                                    const isOpen = expandedHistoryTs === entry.ts;
                                    const diff = diffSnapshots(entry.snapshot, items);
                                    const hasChanges = diff.added.length + diff.removed.length + diff.changed.length > 0;
                                    return (
                                        <div key={entry.ts} className={`border rounded-lg overflow-hidden transition ${isOpen ? "border-indigo-300 shadow-sm" : "border-slate-100"}`}>
                                            <button
                                                onClick={() => setExpandedHistoryTs(isOpen ? null : entry.ts)}
                                                className="w-full flex items-start justify-between gap-2 px-3 py-2.5 text-left hover:bg-slate-50 transition"
                                            >
                                                <div>
                                                    <p className="text-xs font-semibold text-slate-700">{entry.label}</p>
                                                    <p className="text-[10px] text-slate-400 mt-0.5 flex gap-2">
                                                        <span>{entry.snapshot.length} items</span>
                                                        {hasChanges && (
                                                            <span className="flex gap-1.5">
                                                                {diff.added.length > 0 && <span className="text-green-600">+{diff.added.length}</span>}
                                                                {diff.removed.length > 0 && <span className="text-red-500">−{diff.removed.length}</span>}
                                                                {diff.changed.length > 0 && <span className="text-amber-500">~{diff.changed.length}</span>}
                                                            </span>
                                                        )}
                                                        {!hasChanges && <span className="text-slate-300">(current)</span>}
                                                    </p>
                                                </div>
                                                <svg className={`w-3.5 h-3.5 text-slate-400 mt-0.5 shrink-0 transition-transform ${isOpen ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                                            </button>
                                            {isOpen && (
                                                <div className="border-t border-slate-100 bg-slate-50 px-3 pb-3 pt-2 space-y-2">
                                                    {!hasChanges && <p className="text-[10px] text-slate-400 italic">No differences from current state.</p>}
                                                    {diff.added.length > 0 && (
                                                        <div>
                                                            <p className="text-[10px] font-semibold text-green-700 uppercase mb-1">Added (since this snapshot)</p>
                                                            {diff.added.map((i: any) => <p key={i.id} className="text-[11px] text-green-700 bg-green-50 rounded px-2 py-0.5 mb-0.5">+ {i.name || "(unnamed)"}</p>)}
                                                        </div>
                                                    )}
                                                    {diff.removed.length > 0 && (
                                                        <div>
                                                            <p className="text-[10px] font-semibold text-red-600 uppercase mb-1">Removed (since this snapshot)</p>
                                                            {diff.removed.map((i: any) => <p key={i.id} className="text-[11px] text-red-600 bg-red-50 rounded px-2 py-0.5 mb-0.5">− {i.name || "(unnamed)"}</p>)}
                                                        </div>
                                                    )}
                                                    {diff.changed.length > 0 && (
                                                        <div>
                                                            <p className="text-[10px] font-semibold text-amber-700 uppercase mb-1">Modified</p>
                                                            {diff.changed.map((i: any) => {
                                                                const prev = entry.snapshot.find((p: any) => p.id === i.id);
                                                                return (
                                                                    <div key={i.id} className="text-[11px] text-amber-800 bg-amber-50 rounded px-2 py-1 mb-0.5">
                                                                        <span className="font-medium">{i.name}</span>
                                                                        {prev && String(prev.quantity) !== String(i.quantity) && <span className="text-slate-500"> qty {prev.quantity}→{i.quantity}</span>}
                                                                        {prev && String(prev.unitCost) !== String(i.unitCost) && <span className="text-slate-500"> ${prev.unitCost}→${i.unitCost}</span>}
                                                                    </div>
                                                                );
                                                            })}
                                                        </div>
                                                    )}
                                                    <button
                                                        onClick={() => revertToHistory(entry)}
                                                        className="mt-1 w-full text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded px-3 py-1.5 transition"
                                                    >
                                                        Revert to this snapshot
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    );
                                })
                            )}
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
                                    <p className="text-xs text-purple-600">Powered by Claude • Vancouver, WA pricing</p>
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

            {poCreateItemId && context.type === "project" && (
                <POQuickCreateModal
                    estimateItemId={poCreateItemId}
                    suggestedAmount={(() => {
                        const itm = items.find((i: any) => i.id === poCreateItemId);
                        if (!itm) return null;
                        const b = internalBudget({ budgetQuantity: itm.budgetQuantity, quantity: parseFloat(itm.quantity) || 0, budgetRate: itm.budgetRate, baseCost: itm.baseCost });
                        return b;
                    })()}
                    projectId={context.id}
                    onClose={() => setPOCreateItemId(null)}
                    onCreated={(po) => handlePOCreated(poCreateItemId, po)}
                />
            )}

            {poLinkItemId && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm">
                    <div className="bg-white rounded-xl shadow-xl border border-slate-200 w-full max-w-sm overflow-hidden">
                        <div className="px-6 py-4 border-b border-slate-100 flex justify-between items-center bg-slate-50">
                            <h3 className="font-bold text-slate-800">Link Purchase Order</h3>
                            <button onClick={() => setPOLinkItemId(null)} className="text-slate-400 hover:text-slate-600">
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
                            </button>
                        </div>
                        <div className="p-4 max-h-60 overflow-y-auto divide-y divide-slate-50">
                            {loadingPOs ? (
                                <div className="text-sm text-slate-400 text-center py-4">Loading...</div>
                            ) : projectPOs.length === 0 ? (
                                <div className="text-sm text-slate-400 text-center py-4">No purchase orders found</div>
                            ) : projectPOs.map(po => (
                                <button
                                    key={po.id}
                                    onClick={() => handleSelectPO(poLinkItemId, po)}
                                    className="w-full text-left px-3 py-2 text-sm hover:bg-indigo-50 transition flex justify-between items-center"
                                >
                                    <span className="font-medium">{po.code} — {po.vendor?.name}</span>
                                    <span className="text-slate-500">{formatCurrency(Number(po.totalAmount))}</span>
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

