"use client";

import {
    computeEstimateItemTotals,
    computeEstimateSubtotal,
    normalizeSectionTypes,
    rm,
    serializeEstimateItemsForSave,
    normalizeEstimateItemForSave,
} from "@/lib/estimate-item-payload";

/** Recalculate milestone amounts: percentage-driven get amounts from %, fixed keep theirs, last absorbs residual */
function recalcMilestoneAmounts(schedules: any[], total: number): any[] {
    const cloned = schedules.map(s => ({ ...s }));
    const unpaid = cloned.filter(s => s.status !== "Paid");
    if (unpaid.length === 0) return cloned;

    const paidSum = cloned.filter(s => s.status === "Paid").reduce((sum, s) => sum + (parseFloat(s.amount) || 0), 0);
    const available = rm(total - paidSum);
    const lastUnpaid = unpaid[unpaid.length - 1];

    if (unpaid.length === 1) {
        lastUnpaid.amount = String(Math.max(0, available));
        const pct = parseFloat(lastUnpaid.percentage) || 0;
        if (pct > 0 && Math.abs(available - rm(total * (pct / 100))) > 0.01) {
            lastUnpaid.percentage = "";
        }
        return cloned;
    }

    for (const s of unpaid) {
        if (s === lastUnpaid) continue;
        const pct = parseFloat(s.percentage) || 0;
        if (pct > 0) s.amount = String(rm(total * (pct / 100)));
    }

    const othersSum = unpaid.filter(s => s !== lastUnpaid).reduce((sum, s) => sum + (parseFloat(s.amount) || 0), 0);
    const residual = rm(available - othersSum);
    lastUnpaid.amount = String(Math.max(0, residual));

    const lastPct = parseFloat(lastUnpaid.percentage) || 0;
    if (lastPct > 0 && Math.abs(residual - rm(total * (lastPct / 100))) > 0.01) {
        lastUnpaid.percentage = "";
    }

    return cloned;
}

/** A PO-link / schedule-task restore payload left pending after an undo or history revert
 *  whose item-row save succeeded but whose association restore failed (or hasn't run yet). */
type PendingAssociationRestore = {
    links: { estimateItemId: string; purchaseOrderId: string; createdAt?: string }[];
    scheduleTasks: { scheduleTaskId: string; estimateItemId: string }[];
    /** Bounded-retry counter — see MAX_PENDING_RESTORE_ATTEMPTS/attemptPendingRestore below.
     *  Persisted alongside the payload so a browser refresh/remount doesn't reset the budget
     *  and let a permanently-failing restore retry forever. */
    attempts?: number;
};

/** After this many failed attempts, stop retrying a pending restore automatically and tell
 *  the user once instead of silently looping on every future save. */
const MAX_PENDING_RESTORE_ATTEMPTS = 5;

/** Errors that retrying won't fix — the caller lacks permission, or the estimate/PO/schedule
 *  target no longer exists. Give up on these immediately rather than burning the attempt
 *  budget on a request that will never succeed. */
function isPermanentRestoreError(e: any): boolean {
    const msg = e?.message || "";
    return /forbidden/i.test(msg) || /not found/i.test(msg) || /requires a project/i.test(msg);
}

/** sessionStorage key for a pending restore, scoped per estimate — so a browser refresh or
 *  component remount between the row-recreation save and the association restore doesn't
 *  silently lose the payload (see pendingAssociationRestoreRef comment in the component). */
function pendingRestoreStorageKey(estimateId: string) {
    return `probuild:estimate-pending-restore:${estimateId}`;
}

function loadPendingRestore(estimateId: string): PendingAssociationRestore | null {
    if (typeof window === "undefined") return null;
    try {
        const raw = window.sessionStorage.getItem(pendingRestoreStorageKey(estimateId));
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

function persistPendingRestore(estimateId: string, payload: PendingAssociationRestore | null) {
    if (typeof window === "undefined") return;
    try {
        const key = pendingRestoreStorageKey(estimateId);
        if (!payload || (payload.links.length === 0 && payload.scheduleTasks.length === 0)) {
            window.sessionStorage.removeItem(key);
        } else {
            window.sessionStorage.setItem(key, JSON.stringify(payload));
        }
    } catch {
        // sessionStorage unavailable (private browsing, quota) — the in-memory ref still
        // covers the same-session cases; only the across-remount case degrades.
    }
}

/** Merge a new restore payload into whatever's already pending, deduped by
 *  (estimateItemId, purchaseOrderId) for links and by scheduleTaskId for schedule tasks, so
 *  two restores queued before either resolves don't clobber each other. */
function mergePendingRestore(existing: PendingAssociationRestore | null, addition: PendingAssociationRestore): PendingAssociationRestore {
    const linkMap = new Map((existing?.links ?? []).map(l => [`${l.estimateItemId}:${l.purchaseOrderId}`, l] as const));
    for (const l of addition.links) linkMap.set(`${l.estimateItemId}:${l.purchaseOrderId}`, l);
    const taskMap = new Map((existing?.scheduleTasks ?? []).map(t => [t.scheduleTaskId, t] as const));
    for (const t of addition.scheduleTasks) taskMap.set(t.scheduleTaskId, t);
    // Reset the attempt counter — merging in new links/tasks is meaningfully different work
    // from whatever may have already failed a few times, so it gets a fresh bounded-retry
    // budget instead of inheriting a near-exhausted count from an unrelated prior restore.
    return { links: Array.from(linkMap.values()), scheduleTasks: Array.from(taskMap.values()), attempts: 0 };
}

/** Remove entries matching the given (estimateItemId, purchaseOrderId) pairs from a pending
 *  restore payload. Used whenever a later user action explicitly removes a link (a manual
 *  unlink, or a "replace"-mode revert's own stale-link cleanup) — without this, a still-pending
 *  restore queued before that removal could replay afterward and resurrect the link the user
 *  just deliberately removed, since mergePendingRestore only ever unions entries in. */
function removePendingLinks(existing: PendingAssociationRestore | null, toRemove: { estimateItemId: string; purchaseOrderId: string }[]): PendingAssociationRestore | null {
    if (!existing || toRemove.length === 0) return existing;
    const removeKeys = new Set(toRemove.map(l => `${l.estimateItemId}:${l.purchaseOrderId}`));
    const links = existing.links.filter(l => !removeKeys.has(`${l.estimateItemId}:${l.purchaseOrderId}`));
    if (links.length === existing.links.length) return existing;
    return { ...existing, links };
}

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import dynamic from "next/dynamic";
import { saveEstimate, createInvoiceFromEstimate, deleteEstimate, duplicateEstimate, saveEstimateAsTemplate, uploadEstimateFile, deleteEstimateFile, getEstimateFiles, saveItemsAsAssembly, getEstimateTemplates, deleteAssembly, updateItemApproval, bulkUpdateItemApproval, linkPOToEstimateItem, unlinkPOFromEstimateItem, restoreEstimateItemAssociations, getProjectPurchaseOrdersForLinking, recordEstimatePayment, sendEstimatePaymentReceipt, unrecordEstimatePayment, getDocumentTemplates, createDocumentTemplate } from "@/lib/actions";
import type { RestoreEstimateItemAssociationsResult } from "@/lib/actions";
import RichTextEditor from "@/components/RichTextEditor";
import { useRouter } from "next/navigation";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";
import ExpensesTab from "./ExpensesTab";

const SendEstimateModal = dynamic(() => import("@/components/SendEstimateModal"), { ssr: false });
const SelectVendorModal = dynamic(() => import("./SelectVendorModal"), { ssr: false });
const LogPaymentModal = dynamic(() => import("./LogPaymentModal"), { ssr: false });
const RecordPaymentModal = dynamic(() => import("@/components/RecordPaymentModal"), { ssr: false });

const EST_METHOD_LABELS: Record<string, string> = {
    card: "Card",
    ach: "ACH",
    check: "Check",
    cash: "Cash",
    zelle: "Zelle",
    venmo: "Venmo",
    credit_card: "Credit Card",
    wire: "Wire Transfer",
    other: "Other",
};
function formatEstPaymentMethod(method: string | null | undefined, ref: string | null | undefined): string {
    if (!method) return "";
    const label = EST_METHOD_LABELS[method] ?? method.toUpperCase();
    if (method === "check" && ref) return `Check #${ref}`;
    if (ref) return `${label} · ${ref}`;
    return label;
}
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";
import { getTaxCertStatus, formatCertExpiry } from "@/lib/tax-cert";

const ReusableSignaturePad = dynamic(() => import("@/components/ReusableSignaturePad"), { ssr: false });

import DocumentComments from "@/components/DocumentComments";
import BudgetStrip from "./BudgetStrip";

const POQuickCreateModal = dynamic(() => import("./POQuickCreateModal"), { ssr: false });
const UndoPaymentModal = dynamic(() => import("@/components/UndoPaymentModal"), { ssr: false });

import { internalBudget, derivedMarginPct, marginPatchForRate, marginIsSettable } from "@/lib/budget-math";
import { normalizeItemPoLinks } from "@/lib/estimate-item-po-links";
import { formatMoneyDate, isDateOnly } from "@/lib/payment-date";

// Prompt the user copies into ChatGPT so its output imports cleanly via "Import from ChatGPT".
// Mirrors the JSON shape that /api/ai-estimate/import + transformPhasesToItems expect.
const CHATGPT_ESTIMATE_PROMPT = `You are a residential remodeling estimator. Produce a detailed construction estimate for the project described below as VALID JSON ONLY (no markdown, no commentary), in exactly this structure:

{
  "phases": [
    {
      "phaseName": "string (e.g. Demolition)",
      "phaseCode": "string (optional)",
      "items": [
        { "name": "string", "description": "string", "costType": "Labor | Material | Allowance | Subcontractor | Equipment | Other", "quantity": number, "unit": "string e.g. sq ft, hr, each, job, linear ft", "unitCost": number }
      ]
    }
  ],
  "paymentMilestones": [ { "name": "string", "percentage": number } ]
}

Rules:
- Organize into 6-12 logical construction phases, 2-5 line items each.
- "unitCost" is the FINAL price charged to the client per unit (cost + markup already included). Line total = quantity x unitCost.
- "costType" must be exactly one of the listed values. Use "Allowance" for customer selections (fixtures, finishes, appliances).
- Use realistic Vancouver, WA / Pacific Northwest 2024-2025 market rates.
- Provide 3-4 payment milestones whose percentages sum to 100.
- Output ONLY the JSON object — no backticks, no explanation.

PROJECT: <describe the scope of work, square footage, finishes, etc.>`;

type ActivityEvent = { id: string; ts: string; kind: "created" | "sent" | "viewed" | "signed" | "invoice" | "payment" | "other"; title: string; detail?: string | null };

export default function EstimateEditor({ context, initialEstimate, salesTaxes = [], settings, activityEvents }: { context: { type: "project" | "lead", id: string, name: string, clientName: string, clientEmail?: string, location?: string, clientTaxExemptCertUrl?: string | null, clientTaxExemptCertExpiresAt?: string | null }, initialEstimate: any, salesTaxes?: { id?: string; name: string; rate: number; isDefault?: boolean }[], settings?: any, activityEvents?: ActivityEvent[] }) {
    const router = useRouter();
    const [title, setTitle] = useState(initialEstimate.title);
    const [code, setCode] = useState(initialEstimate.code);
    const [status, setStatus] = useState(initialEstimate.status);
    const [items, setItems] = useState<any[]>(() => (initialEstimate.items || []).map(normalizeItemPoLinks));
    const [paymentSchedules, setPaymentSchedules] = useState<any[]>(initialEstimate.paymentSchedules || []);
    // Invoice generated from this estimate (if any) — milestone edits here do not
    // cascade to it, so the schedule UI warns when one exists.
    const linkedInvoice: { id: string; code: string; status: string } | null =
        initialEstimate.invoices?.[0] || null;
    const [isSaving, setIsSaving] = useState(false);
    const [isCreatingInvoice, setIsCreatingInvoice] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const [activeTab, setActiveTab] = useState("builder"); // builder | expenses
    const [showSendModal, setShowSendModal] = useState(false);
    const [costCodes, setCostCodes] = useState<any[]>([]);
    // Cost types are an expense concept; estimate lines carry a plain type label instead.
    const ITEM_TYPE_LABELS = ["Labor", "Material", "Allowance", "Subcontractor", "Equipment", "Other"];
    const [showAiModal, setShowAiModal] = useState(false);
    const [aiPrompt, setAiPrompt] = useState("");
    const [isGenerating, setIsGenerating] = useState(false);
    const [showImportModal, setShowImportModal] = useState(false);
    const [importJson, setImportJson] = useState("");
    const [isImporting, setIsImporting] = useState(false);
    const [showMoreMenu, setShowMoreMenu] = useState(false);
    const [viewMode, setViewMode] = useState<"internal" | "client">("client");
    // The row whose sell price is being repaired. In internal view the price normally locks once a
    // budget rate exists, but a row with NO valid sell price has to be repairable or its disabled
    // margin input tells the user to do something they can't. Unlocking on the price alone isn't
    // enough: typing "100" emits "1" first, which is already valid and would relock the field
    // mid-keystroke at $1. Repair mode is held for the whole focus and released on blur.
    const [repairingSellPriceItemId, setRepairingSellPriceItemId] = useState<string | null>(null);
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
    const [recordingEstPayment, setRecordingEstPayment] = useState<{ id: string; name: string; amount: number } | null>(null);
    const [isSendingEstReceipt, setIsSendingEstReceipt] = useState<string | null>(null);
    const [isUndoingEstPayment, setIsUndoingEstPayment] = useState<string | null>(null);
    const [undoPaymentTarget, setUndoPaymentTarget] = useState<any | null>(null);
    const savedScheduleIds = useMemo(() => new Set((initialEstimate.paymentSchedules || []).map((s: any) => s.id)), [initialEstimate.paymentSchedules]);
    const [processingFeeMarkup, setProcessingFeeMarkup] = useState<number>(Number(initialEstimate.processingFeeMarkup) || 0);
    const [hideProcessingFee, setHideProcessingFee] = useState<boolean>(initialEstimate.hideProcessingFee ?? true);
    const [taxExempt, setTaxExempt] = useState<boolean>(initialEstimate.taxExempt ?? false);
    const defaultTaxRate = salesTaxes.find(t => t.isDefault) || salesTaxes[0] || null;
    // Preserve the originally saved rate even if it was renamed/removed from settings,
    // so we don't silently overwrite it with the default on next save.
    const orphanedRate = useMemo(() => {
        const savedName = initialEstimate.taxRateName;
        const savedPct = initialEstimate.taxRatePercent;
        if (!savedName || savedPct == null) return null;
        if (salesTaxes.some(t => t.name === savedName && Number(t.rate) === Number(savedPct))) return null;
        return { name: savedName, rate: Number(savedPct), isDefault: false, orphaned: true as const };
    }, [initialEstimate.taxRateName, initialEstimate.taxRatePercent, salesTaxes]);
    const taxOptions = orphanedRate ? [...salesTaxes, orphanedRate] : salesTaxes;
    const [selectedTaxName, setSelectedTaxName] = useState<string | null>(
        initialEstimate.taxRateName ?? defaultTaxRate?.name ?? null
    );
    const [isAiFilling, setIsAiFilling] = useState(false);
    const [isAiAssigningPhases, setIsAiAssigningPhases] = useState(false);
    const [targetMargin, setTargetMargin] = useState<string>(String(initialEstimate.targetMarginPercent ?? 25));
    const [overwriteExisting, setOverwriteExisting] = useState(false);
    const [expirationDate, setExpirationDate] = useState<string>(initialEstimate.expirationDate ? new Date(initialEstimate.expirationDate).toISOString().split("T")[0] : "");
    const [showSidebar, setShowSidebar] = useState(false);
    const [sidebarTab, setSidebarTab] = useState<"overview" | "activity" | "comments" | "history">("overview");
    const [termsAndConditions, setTermsAndConditions] = useState<string>(initialEstimate.termsAndConditions || "");
    const [showTerms, setShowTerms] = useState(false);
    const [termsTemplates, setTermsTemplates] = useState<{id: string; name: string; body: string; isDefault: boolean}[]>([]);
    const [memo, setMemo] = useState<string>(initialEstimate.memo || "");
    // Project Overview / Vision (client-facing cover section, no pricing)
    const [overviewEnabled, setOverviewEnabled] = useState<boolean>(initialEstimate.overviewEnabled ?? false);
    const [overviewTitle, setOverviewTitle] = useState<string>(initialEstimate.overviewTitle || "");
    const [overviewBody, setOverviewBody] = useState<string>(initialEstimate.overviewBody || "");
    const [showOverview, setShowOverview] = useState<boolean>(!!initialEstimate.overviewEnabled);
    const [overviewTemplates, setOverviewTemplates] = useState<{ id: string; name: string; body: string; isDefault: boolean }[]>([]);
    // Estimate Notes & Assumptions (client-facing, placed before/after line items)
    const [notesEnabled, setNotesEnabled] = useState<boolean>(initialEstimate.notesEnabled ?? false);
    const [notesTitle, setNotesTitle] = useState<string>(initialEstimate.notesTitle || "");
    const [notesBody, setNotesBody] = useState<string>(initialEstimate.notesBody || "");
    const [notesPlacement, setNotesPlacement] = useState<"before" | "after">(initialEstimate.notesPlacement === "before" ? "before" : "after");
    const [showNotes, setShowNotes] = useState<boolean>(!!initialEstimate.notesEnabled);
    const [notesTemplates, setNotesTemplates] = useState<{ id: string; name: string; body: string; isDefault: boolean }[]>([]);
    const [isSavingOverviewTpl, setIsSavingOverviewTpl] = useState(false);
    const [isSavingNotesTpl, setIsSavingNotesTpl] = useState(false);
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
    const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => {
        const initialItems = initialEstimate.items || [];
        const parentIds = initialItems.filter((i: any) => i.parentId).map((i: any) => i.parentId);
        return new Set(parentIds);
    });
    const [history, setHistory] = useState<Array<{ ts: number; label: string; snapshot: any[] }>>([]);
    const [showHistory, setShowHistory] = useState(false);
    const [expandedHistoryTs, setExpandedHistoryTs] = useState<number | null>(null);
    const [poCreateItemId, setPOCreateItemId] = useState<string | null>(null);
    const [poLinkItemId, setPOLinkItemId] = useState<string | null>(null);
    const [projectPOs, setProjectPOs] = useState<any[]>([]);
    const [loadingPOs, setLoadingPOs] = useState(false);

    const lastSavedStateRef = useRef<string>("");

    // Mirrors `items` so undo/restore code can read the just-restored array immediately —
    // `items` itself is frozen inside whatever render's closure captured it (e.g. a toast's
    // onClick from a stale render), so it can't be trusted for that. Kept in sync for the
    // normal case by the effect below; restoreItems also writes it directly so handleSave
    // sees the restored rows synchronously, before that effect has a chance to run.
    const itemsRef = useRef(items);
    useEffect(() => { itemsRef.current = items; }, [items]);

    // Optimistic-concurrency revision for the whole item collection — a single counter, not
    // per-item. Kept in a ref rather than component state because it must survive across
    // renders without itself triggering one, and because a save triggered from a stale render's
    // closure (see fieldsRef/itemsRef above) must read whatever this session most recently saved
    // at, not whatever was current when that closure was created. Seeded from the server-loaded
    // estimate; updated after every successful save (see runSave) from the server's authoritative
    // itemsRevision. See docs/specs/estimate-item-optimistic-concurrency.md REVISION 2.
    const itemsRevisionRef = useRef<number>(initialEstimate.itemsRevision ?? 0);

    // Set after a save is rejected for a stale version — suppresses further AUTOsaves (a manual
    // save may still be attempted, and will fail the same way) so the editor doesn't retry the
    // doomed payload on a timer. Cleared on reload only (the toast tells the user to reload).
    const saveConflictRef = useRef(false);

    // Mirrors every estimate-level field that runSave persists alongside items (title, tax,
    // notes, payment schedules, etc.) — same reason as itemsRef: a save triggered from a
    // stale render's closure (e.g. the delete-undo toast's onClick, bound at delete time)
    // must send whatever the user has typed/changed SINCE, not whatever was current when
    // that closure was created. Kept in sync every render by the effect below.
    const fieldsRef = useRef({
        title, code, status, processingFeeMarkup, hideProcessingFee, expirationDate,
        memo, termsAndConditions, overviewEnabled, overviewTitle, overviewBody,
        notesEnabled, notesTitle, notesBody, notesPlacement, signatureUrl, targetMargin,
        taxExempt, selectedTaxName, paymentSchedules,
    });
    useEffect(() => {
        fieldsRef.current = {
            title, code, status, processingFeeMarkup, hideProcessingFee, expirationDate,
            memo, termsAndConditions, overviewEnabled, overviewTitle, overviewBody,
            notesEnabled, notesTitle, notesBody, notesPlacement, signatureUrl, targetMargin,
            taxExempt, selectedTaxName, paymentSchedules,
        };
    }, [
        title, code, status, processingFeeMarkup, hideProcessingFee, expirationDate,
        memo, termsAndConditions, overviewEnabled, overviewTitle, overviewBody,
        notesEnabled, notesTitle, notesBody, notesPlacement, signatureUrl, targetMargin,
        taxExempt, selectedTaxName, paymentSchedules,
    ]);

    // Serializes every call to handleSave so overlapping saves (e.g. the blur-triggered
    // autosave racing the delete-undo's own restore save) always execute in enqueue order
    // instead of concurrently, where whichever server request happened to land last would
    // silently win and could re-delete a just-restored item. Each call chains onto whatever
    // is already in flight and waits for it to settle (success or failure) before starting.
    const saveQueueRef = useRef<Promise<void>>(Promise.resolve());

    // Holds a PO-link/schedule-task restore payload after step 2 (the item save) of undo
    // has succeeded but step 3 (restoreEstimateItemAssociations) has failed. Kept here —
    // not just reported as a one-off error — so the next save (or the toast's Retry action)
    // can retry it; without this, lastSavedStateRef already marks the item state saved and a
    // later save would silently early-return, permanently losing the associations. Also
    // mirrored to sessionStorage (see loadPendingRestore/persistPendingRestore) so a browser
    // refresh or component remount between step 2 and step 3 doesn't lose it either.
    const pendingAssociationRestoreRef = useRef<PendingAssociationRestore | null>(null);

    // Recover a pending restore left over from a previous session/tab that never resolved —
    // e.g. the row-recreation save succeeded but the tab closed before the association
    // restore ran. retryAssociationRestore is a stable function declaration (hoisted) that
    // reads the ref fresh at call time, so referencing it here before its definition is fine.
    useEffect(() => {
        const saved = loadPendingRestore(initialEstimate.id);
        if (saved && (saved.links.length > 0 || saved.scheduleTasks.length > 0)) {
            pendingAssociationRestoreRef.current = saved;
            retryAssociationRestore();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only recovery
    }, []);

    const getEstimateSnapshot = useCallback((itemsOverride?: any[], fieldsOverride?: Partial<typeof fieldsRef.current>) => {
        const srcItems = itemsOverride ?? itemsRef.current;
        const f = { ...fieldsRef.current, ...fieldsOverride };
        const activeTax = taxOptions.find(t => t.name === f.selectedTaxName) || defaultTaxRate;

        // Exactly what a save would write, field for field: serialize (order, section
        // roll-up, unitCost mirror) then project through the same function saveEstimate's
        // toItemData uses. Hand-rolling a shorter list here is what made budget-only edits
        // invisible to the change check, so the save reported success and wrote nothing.
        const mappedItems = serializeEstimateItemsForSave(srcItems)
            .map((item, index) => normalizeEstimateItemForSave(item, index));

        const mappedSchedules = f.paymentSchedules.map((schedule: any, index: number) => ({
            id: schedule.id || null,
            name: schedule.name || "",
            amount: String(schedule.amount || "0"),
            dueDate: schedule.dueDate ? new Date(schedule.dueDate).toISOString().split("T")[0] : null,
            status: schedule.status || "Pending",
            paymentMethod: schedule.paymentMethod || null,
            paymentReference: schedule.paymentReference || null,
            percentage: String(schedule.percentage || "0"),
            type: schedule.type || null,
            order: index
        }));

        return {
            title: f.title || "",
            code: f.code || "",
            status: f.status || "Draft",
            processingFeeMarkup: Number(f.processingFeeMarkup) || 0,
            hideProcessingFee: !!f.hideProcessingFee,
            expirationDate: f.expirationDate ? new Date(f.expirationDate).toISOString().split("T")[0] : null,
            memo: f.memo || null,
            termsAndConditions: f.termsAndConditions || null,
            overviewEnabled: !!f.overviewEnabled,
            overviewTitle: f.overviewTitle || null,
            overviewBody: f.overviewBody || null,
            notesEnabled: !!f.notesEnabled,
            notesTitle: f.notesTitle || null,
            notesBody: f.notesBody || null,
            notesPlacement: f.notesPlacement,
            signatureUrl: f.signatureUrl || null,
            targetMarginPercent: parseFloat(f.targetMargin) || 25,
            taxExempt: !!f.taxExempt,
            taxRateName: f.taxExempt ? null : (activeTax?.name || null),
            taxRatePercent: f.taxExempt ? null : (activeTax?.rate ?? null),
            items: mappedItems,
            paymentSchedules: mappedSchedules,
        };
    }, [taxOptions, defaultTaxRate]);

    useEffect(() => {
        lastSavedStateRef.current = JSON.stringify(getEstimateSnapshot());
    }, []);

    // Derived: rolled-up total per section header, aggregating through nested sections
    const sectionTotals = useMemo(() => {
        const totals = computeEstimateItemTotals(items);
        const map = new Map<string, number>();
        items.forEach((item, index) => {
            if (totals[index].isSection && item.id) map.set(item.id, totals[index].total);
        });
        return map;
    }, [items]);

    // A row is a section header if it is typed as one or at least one child references it
    const sectionIds = useMemo(() => new Set(sectionTotals.keys()), [sectionTotals]);

    // Auto-expand textarea ref handler
    const autoExpand = useCallback((el: HTMLTextAreaElement | null) => {
        if (!el) return;
        el.style.height = "auto";
        el.style.height = el.scrollHeight + "px";
    }, []);

    // AI description suggestion
    async function suggestDescription(itemId: string) {
        // Capture the id up front, not an index — this awaits a fetch, and a reorder or delete
        // mid-flight would leave a captured index pointing at the wrong row by the time the
        // response comes back.
        const item = items.find((i: any) => i.id === itemId);
        if (!item?.name?.trim() || aiSuggestingDesc === item.id) return;
        setAiSuggestingDesc(item.id);
        try {
            const parent = item.parentId ? items.find((i: any) => i.id === item.parentId) : null;
            const res = await fetch("/api/ai-estimate/suggest", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    mode: "description",
                    itemName: item.name,
                    parentName: parent?.name,
                    projectName: context.name,
                    costType: item.type,
                }),
            });
            if (res.ok) {
                const data = await res.json();
                if (data.description) {
                    updateItem(itemId, { description: data.description });
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
    async function suggestSubitems(parentId: string) {
        // Capture id up front (not index), matching suggestDescription — this awaits a fetch.
        const parent = items.find((i: any) => i.id === parentId);
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
            costTypeId: null,
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

    useEffect(() => {
        getDocumentTemplates("terms").then((data: any[]) => {
            setTermsTemplates(data);
            if (!initialEstimate.termsAndConditions) {
                const defaultT = data.find((t: any) => t.isDefault);
                if (defaultT) setTermsAndConditions(defaultT.body);
            }
        }).catch((err) => console.error("[EstimateEditor] Failed to load T&C templates:", err));
    }, []);

    useEffect(() => {
        getDocumentTemplates("overview").then((data: any[]) => setOverviewTemplates(data))
            .catch((err) => console.error("[EstimateEditor] Failed to load overview templates:", err));
        getDocumentTemplates("notes").then((data: any[]) => setNotesTemplates(data))
            .catch((err) => console.error("[EstimateEditor] Failed to load notes templates:", err));
    }, []);

    async function handleSaveDocTemplate(type: "overview" | "notes", body: string) {
        const label = type === "overview" ? "Project Overview" : "Notes & Assumptions";
        if (!body || !body.trim()) {
            toast.error(`Add some ${label} content before saving a template.`);
            return;
        }
        const name = window.prompt(`Save this ${label} as a reusable template. Template name:`)?.trim();
        if (!name) return;
        const setBusy = type === "overview" ? setIsSavingOverviewTpl : setIsSavingNotesTpl;
        setBusy(true);
        try {
            await createDocumentTemplate({ name, type, body });
            const refreshed = await getDocumentTemplates(type);
            if (type === "overview") setOverviewTemplates(refreshed as any);
            else setNotesTemplates(refreshed as any);
            toast.success(`Saved "${name}" template.`);
        } catch (e: any) {
            toast.error(e?.message || "Failed to save template.");
        } finally {
            setBusy(false);
        }
    }

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
        const tItems: any[] = assembly.items || [];
        const hasSections = tItems.some((t: any) => t.type === "Section");

        if (hasSections) {
            // Multi-phase template: keep its Section grouping. Grouping is rebuilt by
            // walking items in order (a Section row starts a group; the CHILD rows after
            // it belong to it). Stored parentId values reference rows of whatever
            // estimate the template was saved from and can't be trusted — but
            // null-vs-set still marks a row as top-level vs child.
            let currentSectionId: string | null = null;
            for (const tItem of tItems) {
                const isSection = tItem.type === "Section";
                const newId = generateId();
                newItems.push({
                    id: newId, name: tItem.name, description: tItem.description || "",
                    type: tItem.type, quantity: tItem.quantity,
                    baseCost: Number(tItem.baseCost) || 0, markupPercent: tItem.markupPercent,
                    unitCost: Number(tItem.unitCost) || 0,
                    total: (tItem.quantity || 0) * (Number(tItem.unitCost) || 0),
                    parentId: isSection || tItem.parentId == null ? null : currentSectionId,
                    costCodeId: tItem.costCodeId, costTypeId: tItem.costTypeId,
                    ...(isSection ? { isSection: true } : {}),
                });
                if (isSection) currentSectionId = newId;
            }
        } else {
            // Flat template: wrap its items in a new section named after the template.
            const sectionId = generateId();
            newItems.push({
                id: sectionId, name: assembly.name, description: "", type: "Section",
                quantity: 1, baseCost: 0, markupPercent: 0, unitCost: 0, total: 0,
                parentId: null, costCodeId: null, costTypeId: null, isSection: true,
            });
            for (const tItem of tItems) {
                newItems.push({
                    id: generateId(), name: tItem.name, description: tItem.description || "",
                    type: tItem.type, quantity: tItem.quantity,
                    baseCost: Number(tItem.baseCost) || 0, markupPercent: tItem.markupPercent,
                    unitCost: Number(tItem.unitCost) || 0,
                    total: (tItem.quantity || 0) * (Number(tItem.unitCost) || 0),
                    parentId: sectionId, costCodeId: tItem.costCodeId, costTypeId: tItem.costTypeId,
                });
            }
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
            // The sync route reads the estimate from the database, so anything typed since the
            // last save would be invisible to it and QuickBooks would receive stale prices or a
            // stale section hierarchy. Save first, exactly as the Change Order and Purchase
            // Order actions above do.
            //
            // Silent because this handler owns the messaging for the whole operation: a
            // non-silent save toasts "Estimate saved successfully" immediately before the sync
            // toast, and reports a save failure twice (once itself, once via the catch below).
            // skipRefresh avoids a redundant RSC round-trip in the middle of the sync.
            try {
                await handleSave({ silent: true, skipRefresh: true });
            } catch (e: any) {
                // A CAS conflict already raised its own toast carrying the Reload action, so it
                // must not be spoken over. Everything else has to say plainly that the push did
                // not happen — otherwise a failed save reads as a failed sync.
                if (!e?.isSaveConflict) {
                    // The fixed sentence always leads: `e.message` is set for nearly every Error, so
                    // using it as the whole message would drop the part the user actually needs.
                    const detail = e?.message ? ` (${e.message})` : "";
                    toast.error(`We couldn't confirm the save — QuickBooks was not updated.${detail}`);
                }
                return;
            }

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
    }, []);

    // Section flags / rolled-up totals, shared by the subtotal and the margin math below
    const itemTotals = useMemo(() => computeEstimateItemTotals(items), [items]);
    // Subtotal from leaf items only (sections would double-count)
    const subtotal = computeEstimateSubtotal(items);
    const activeTax = taxOptions.find(t => t.name === selectedTaxName) || defaultTaxRate;
    const taxRate = taxExempt ? 0 : (activeTax ? activeTax.rate / 100 : 0.088);
    const taxRateDisplay = activeTax ? Number(parseFloat(String(activeTax.rate)).toFixed(4)) : null;
    const taxName = taxExempt ? "Tax Exempt" : (activeTax ? `${activeTax.name} (${taxRateDisplay}%)` : "Estimated Tax (8.8%)");
    // WA DOR: exempt sales need a reseller permit / exemption certificate on the client record
    const taxCertStatus = getTaxCertStatus({ url: context.clientTaxExemptCertUrl, expiresAt: context.clientTaxExemptCertExpiresAt });
    const showTaxCertWarning = taxExempt && taxCertStatus !== "valid";
    const taxCertFixHref = context.type === "lead" ? `/leads/${context.id}` : "/settings/contacts";
    const processingFee = processingFeeMarkup > 0 ? rm(subtotal * (processingFeeMarkup / 100)) : 0;
    const tax = rm(subtotal * taxRate);
    const total = rm(subtotal + tax + processingFee);
    const paidMilestonesSum = paymentSchedules
        .filter(s => s.status === "Paid")
        .reduce((sum, s) => sum + (parseFloat(s.amount) || 0), 0);
    const dynamicBalanceDue = rm(total - paidMilestonesSum);

    // Auto-recalculate percentage-based milestones when total changes (last absorbs rounding residual)
    useEffect(() => {
        setPaymentSchedules(prev => {
            if (prev.length === 0) return prev;
            const updated = recalcMilestoneAmounts(prev, total);
            const changed = updated.some((s, i) => s.amount !== prev[i].amount);
            return changed ? updated : prev;
        });
    }, [total]);

    // Internal margin calculations
    // Base cost from leaf items only (sections would double-count)
    const totalBaseCost = items.reduce((acc, item, index) => {
        if (itemTotals[index].isSection) return acc;
        const rate = (item.budgetRate !== null && item.budgetRate !== undefined && item.budgetRate !== "")
            ? parseFloat(item.budgetRate)
            : (parseFloat(item.baseCost) || 0);
        const qty = item.budgetQuantity ?? (parseFloat(item.quantity) || 0);
        return acc + (qty * rate);
    }, 0);
    const totalMarkup = subtotal - totalBaseCost;
    const profitMargin = subtotal > 0 ? ((totalMarkup / subtotal) * 100) : 0;

    /**
     * Sell-side subtotal/tax/fee/total for an explicit items array + field set, rather than
     * the render's `total`/`taxRate` consts, which are frozen to whatever render created a
     * stale caller's closure. Shared so every writer of `totalAmount` — and anything that
     * needs the new total BEFORE the state updates land, like applyGeneratedEstimate
     * rebalancing percentage milestones — computes money exactly one way.
     */
    function computeSellTotals(sourceItems: any[], f: typeof fieldsRef.current) {
        const sourceSubtotal = computeEstimateSubtotal(sourceItems);
        const activeTax = taxOptions.find(t => t.name === f.selectedTaxName) || defaultTaxRate;
        const sourceTaxRate = f.taxExempt ? 0 : (activeTax ? activeTax.rate / 100 : 0.088);
        const sourceProcessingFee = f.processingFeeMarkup > 0 ? rm(sourceSubtotal * (f.processingFeeMarkup / 100)) : 0;
        const sourceTax = rm(sourceSubtotal * sourceTaxRate);
        return { activeTax, subtotal: sourceSubtotal, total: rm(sourceSubtotal + sourceTax + sourceProcessingFee) };
    }

    async function handleSave(opts: { silent?: boolean; skipRefresh?: boolean; itemsOverride?: any[]; fieldsOverride?: Partial<typeof fieldsRef.current>; skipHistoryCapture?: boolean } = {}) {
        // Chain this save behind whatever is already in flight (see saveQueueRef comment
        // above) so saves always run one at a time, in the order they were requested. The
        // queue promise itself must never reject — that would break the chain for every
        // future caller — so failures are swallowed there; this call's own promise (`run`)
        // still resolves/rejects normally for its caller.
        const run = saveQueueRef.current.catch(() => {}).then(() => runSave(opts));
        saveQueueRef.current = run.then(() => undefined, () => undefined);
        return run;
    }

    async function runSave({ silent = false, skipRefresh = false, itemsOverride, fieldsOverride, skipHistoryCapture = false }: { silent?: boolean; skipRefresh?: boolean; itemsOverride?: any[]; fieldsOverride?: Partial<typeof fieldsRef.current>; skipHistoryCapture?: boolean } = {}) {
        // `itemsOverride`/`fieldsOverride` let restoreItems (undo / history revert) pass the
        // just-restored items and any fields it wants to force explicitly. Everything else
        // is read from fieldsRef/itemsRef rather than this function's own closure — that
        // closure is frozen to whatever render created it, which is stale for a caller like
        // the delete-undo toast's onClick (bound at delete time, possibly long before the
        // user clicks Undo and edits the title/tax/notes in between).
        const sourceItems = itemsOverride ?? itemsRef.current;
        const f = { ...fieldsRef.current, ...fieldsOverride };
        // Skipped when restoreItems already captured the pre-swap state itself (see its
        // comment) — otherwise this would capture itemsRef.current AFTER restoreItems has
        // already swapped it to the restored/reverted target, recording the wrong snapshot.
        if (!skipHistoryCapture) captureHistory(new Date().toLocaleString());

        // Check if there are actual changes before saving
        const currentSnapshot = getEstimateSnapshot(itemsOverride, fieldsOverride);
        const currentSnapshotStr = JSON.stringify(currentSnapshot);
        const hasChanges = currentSnapshotStr !== lastSavedStateRef.current;

        if (hasChanges) {
            if (!silent) setIsSaving(true);
            try {
                // The rows the change check just compared — reusing them is what keeps the
                // comparison and the write from ever describing different things.
                const mappedItems = currentSnapshot.items;
                const mappedSchedules = f.paymentSchedules.map((schedule: any, index: number) => ({
                    ...schedule,
                    order: index
                }));

                const { activeTax, total: sourceTotal } = computeSellTotals(sourceItems, f);

                const saveResult = await saveEstimate(initialEstimate.id, context.id, context.type, {
                    title: f.title, code: f.code, status: f.status, totalAmount: sourceTotal, paymentSchedules: mappedSchedules,
                    processingFeeMarkup: f.processingFeeMarkup, hideProcessingFee: f.hideProcessingFee,
                    expirationDate: f.expirationDate ? new Date(f.expirationDate).toISOString() : null,
                    memo: f.memo || null,
                    termsAndConditions: f.termsAndConditions || null,
                    overviewEnabled: f.overviewEnabled,
                    overviewTitle: f.overviewTitle || null,
                    overviewBody: f.overviewBody || null,
                    notesEnabled: f.notesEnabled,
                    notesTitle: f.notesTitle || null,
                    notesBody: f.notesBody || null,
                    notesPlacement: f.notesPlacement,
                    signatureUrl: f.signatureUrl || null,
                    targetMarginPercent: parseFloat(f.targetMargin) || 25,
                    taxExempt: f.taxExempt,
                    taxRateName: f.taxExempt ? null : (activeTax?.name || null),
                    taxRatePercent: f.taxExempt ? null : (activeTax?.rate ?? null),
                    itemsRevision: itemsRevisionRef.current,
                }, mappedItems);

                if (!saveResult?.success) {
                    // Someone else's save landed on this estimate's item collection since we
                    // loaded it (an add, delete, update, or wholesale rewrite — the CAS is
                    // estimate-wide, not per-row). The whole save was rejected server-side
                    // (nothing partially applied) — do not touch lastSavedStateRef (state stays
                    // dirty), do not run the pending-association restore below, do not show the
                    // success toast. Suppress further autosaves (see saveConflictRef) — a manual
                    // save may still be attempted and will fail the same way. Reloading is the
                    // only recovery this build offers; the toast says so.
                    saveConflictRef.current = true;
                    toast.error(
                        "This estimate was changed by someone else since you opened it. Your changes were not saved. Reload to get the latest version.",
                        {
                            duration: Infinity,
                            action: { label: "Reload", onClick: () => window.location.reload() },
                        }
                    );
                    const conflictError: any = new Error("Estimate save conflict");
                    conflictError.isSaveConflict = true;
                    throw conflictError;
                }

                // Own this save's revision going forward — set BEFORE lastSavedStateRef so a
                // second autosave from the same open editor reads the revision this save just
                // wrote, not the pre-save one (which would conflict against its own write).
                itemsRevisionRef.current = saveResult.itemsRevision;

                // Mirror the section tags we just persisted back into local state. Serialization
                // is non-mutating, so without this a legacy section (detected only via its
                // children) stays untagged in memory: delete its last child in this same session
                // and it bills its mirrored unitCost again, and the next save overwrites the tag
                // that was just written.
                setItems(prev => normalizeSectionTypes(prev));
                itemsRef.current = normalizeSectionTypes(itemsRef.current);

                // Update the last saved state ref to the new state
                lastSavedStateRef.current = currentSnapshotStr;
            } catch (e: any) {
                console.error("[EstimateEditor] Failed to save estimate:", e);
                // The conflict toast above already said it better than the generic failure toast.
                if (!silent && !e?.isSaveConflict) {
                    toast.error(e?.message || "Failed to save estimate. Please try again.");
                }
                throw e;
            } finally {
                if (!silent) setIsSaving(false);
            }
        }

        // Retry any association restore left pending from a previous undo/revert whose step 3
        // (restoreEstimateItemAssociations) failed after step 2 (the row save) already
        // committed — see pendingAssociationRestoreRef comment. This runs AFTER the row save
        // above, not before: the payload may belong to THIS very save (restoreItems sets it
        // right before calling handleSave to recreate deleted rows), and the associated rows
        // don't exist again until saveEstimate resolves. Running it at the top of runSave (as
        // this used to) would replay against not-yet-existent rows — which the server treats
        // as a harmless no-op success — clearing the payload before the row save even had a
        // chance to fail, permanently losing the one thing the payload exists to protect.
        // If the row save above threw, we never reach here, so the payload is left untouched
        // for the next attempt.
        //
        // The status is returned (handleSave resolves to whatever runSave returns) so a
        // caller that specifically wants to know how the replay went — retryAssociationRestore,
        // driving the manual "Retry" action and mount-time recovery — doesn't have to guess
        // from ref state alone or invoke a second, redundant restore call of its own.
        let pendingRestoreStatus: "success" | "retrying" | "gave-up" | undefined;
        if (pendingAssociationRestoreRef.current) {
            pendingRestoreStatus = await attemptPendingRestore(pendingAssociationRestoreRef.current);
        }

        if (!silent) {
            toast.success("Estimate saved successfully");
        }
        if (hasChanges && !skipRefresh) {
            router.refresh();
        }
        return pendingRestoreStatus;
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
        // Reads itemsRef rather than the `items` closure so a capture triggered from inside
        // handleSave (a normal save) snapshots the actually-current items, not whatever
        // render created this particular closure. restoreItems calls this itself BEFORE
        // swapping itemsRef to a restored/reverted target (and tells runSave to skip its own
        // automatic capture) so this always records the state being left, not the state
        // being restored to.
        setHistory(prev => [{ ts: Date.now(), label, snapshot: JSON.parse(JSON.stringify(itemsRef.current)) }, ...prev.slice(0, 49)]);
    }

    // Shared by the delete-undo toast (B2/B3) and the History panel (B4). Runs three steps,
    // in order: local state, then the save that recreates the rows (with their original ids),
    // then re-attaching the PO links / schedule task that only the save step could not restore
    // (they were severed at the DB level when the row was deleted). Step 3 must come after
    // step 2 — the item row doesn't exist again until the save completes.
    //
    // `mode` distinguishes the two callers: delete-undo ("additive") only ever needs to
    // re-add what THIS delete severed, since nothing else changed underneath it. History
    // revert ("replace") can jump back across other edits that happened after the snapshot
    // was taken, so it also needs to strip associations that don't belong in the target
    // state — see the linksToRemove block below.
    async function restoreItems({ nextItems, links, scheduleTasks, mode = "additive", label }: {
        nextItems: any[];
        links: { estimateItemId: string; purchaseOrderId: string; createdAt?: string }[];
        scheduleTasks: { scheduleTaskId: string; estimateItemId: string }[];
        mode?: "additive" | "replace";
        label: string;
    }) {
        // Capture the state we're LEAVING before swapping itemsRef to nextItems below.
        // captureHistory reads itemsRef.current, so capturing after the swap (as this used
        // to) records the state we're restoring TO, not the one we're restoring FROM — making
        // it impossible to undo an undo or revert a revert. runSave's own automatic capture
        // is skipped for this save (skipHistoryCapture) so it doesn't immediately overwrite
        // this with the target state again.
        captureHistory(label);

        // "replace" mode: strip any PO link that exists on the CURRENT (pre-revert) items but
        // isn't part of the target snapshot — e.g. a link added after this history entry was
        // captured. Computed from itemsRef.current before it gets swapped below.
        //
        // NOTE: schedule-task detachment can't be replayed the same way — the server action
        // (restoreEstimateItemAssociations) only ever attaches/repoints a ScheduleTask, it
        // never detaches one, so a task attached to an item AFTER this snapshot (or moved to
        // a different item) stays attached. That needs a server-side "replace" mode we don't
        // have; flagging as a known gap rather than working around it with an unrelated action.
        let linksToRemove: { estimateItemId: string; purchaseOrderId: string }[] = [];
        if (mode === "replace") {
            const targetLinkKeys = new Set(links.map(l => `${l.estimateItemId}:${l.purchaseOrderId}`));
            linksToRemove = itemsRef.current.flatMap((it: any) =>
                (it.purchaseOrderLinks ?? [])
                    .map((l: any) => ({ estimateItemId: it.id, purchaseOrderId: l.purchaseOrder.id }))
                    .filter((l: any) => !targetLinkKeys.has(`${l.estimateItemId}:${l.purchaseOrderId}`))
            );
        }

        // Recorded (merged with anything already pending, deduped) BEFORE attempting the row
        // save below — previously this was only set after that save succeeded, so if the row
        // save itself failed, the links/schedule-task payload was lost forever: a later manual
        // save would recreate the rows but never re-attach them. Also persisted to
        // sessionStorage so a remount/refresh between now and step 3 doesn't lose it either.
        let mergedPending: PendingAssociationRestore | null = null;
        if (links.length > 0 || scheduleTasks.length > 0) {
            mergedPending = mergePendingRestore(pendingAssociationRestoreRef.current, { links, scheduleTasks });
            pendingAssociationRestoreRef.current = mergedPending;
            persistPendingRestore(initialEstimate.id, mergedPending);
        }

        itemsRef.current = nextItems;
        setItems(nextItems);
        // The row save below (via runSave) also replays whatever's currently pending in
        // pendingAssociationRestoreRef AFTER it commits — including the payload just set
        // above for this very restore, now that the rows exist again (see runSave comment).
        await handleSave({ silent: true, itemsOverride: nextItems, skipHistoryCapture: true });

        if (linksToRemove.length > 0) {
            await Promise.all(linksToRemove.map(l =>
                unlinkPOFromEstimateItem(l.estimateItemId, l.purchaseOrderId)
                    .then(() => {
                        // Supersede: a link this revert deliberately strips must not be
                        // resurrected by some OTHER still-pending restore that happens to
                        // reference the same (item, PO) pair (mergePendingRestore only
                        // unions, so without this an unrelated pending payload could replay
                        // the very link we just removed).
                        const updated = removePendingLinks(pendingAssociationRestoreRef.current, [{ estimateItemId: l.estimateItemId, purchaseOrderId: l.purchaseOrderId }]);
                        if (updated !== pendingAssociationRestoreRef.current) {
                            pendingAssociationRestoreRef.current = updated;
                            persistPendingRestore(initialEstimate.id, updated);
                        }
                    })
                    .catch(() => {
                        console.error(`[EstimateEditor] Failed to unlink stale PO ${l.purchaseOrderId} from item ${l.estimateItemId} during history revert`);
                    })
            ));
        }

        // If mergedPending is still pending on the ref at this point, the replay inside the
        // row save above either hasn't fully succeeded yet (still retrying, bounded) or gave
        // up permanently (already told the user — see attemptPendingRestore). Either way,
        // surface that this restore isn't fully done rather than reporting full success.
        if (mergedPending && pendingAssociationRestoreRef.current) {
            throw new Error("Row restored, but its purchase order / schedule links could not be reattached yet.");
        }
    }

    // Attempts one pending association restore and diffs the server's structured result
    // (RestoreEstimateItemAssociationsResult) against what was sent, so the payload is only
    // ever cleared for entries the server actually confirms — either restored, or reported as
    // PERMANENTLY impossible (its PO/ScheduleTask target is gone or out of scope). Anything the
    // server reports as RETRYABLE (missing.itemIds — the EstimateItem itself isn't back yet)
    // stays pending untouched. This replaces the old "any non-throwing response == full
    // success" assumption, which is what let a call that silently skipped every entry (because
    // the item wasn't recreated yet) still clear the whole payload.
    //
    // A thrown exception here is a genuine server-side failure (auth, estimate/project gone) —
    // no longer how "stale id" skips are reported — so it keeps the same permanent-vs-bounded-
    // retry handling as before.
    async function attemptPendingRestore(pending: PendingAssociationRestore): Promise<"success" | "retrying" | "gave-up"> {
        let result: RestoreEstimateItemAssociationsResult;
        try {
            result = await restoreEstimateItemAssociations({ estimateId: initialEstimate.id, links: pending.links, scheduleTasks: pending.scheduleTasks });
        } catch (e: any) {
            const attempts = (pending.attempts ?? 0) + 1;
            const permanent = isPermanentRestoreError(e);
            if (permanent || attempts >= MAX_PENDING_RESTORE_ATTEMPTS) {
                pendingAssociationRestoreRef.current = null;
                persistPendingRestore(initialEstimate.id, null);
                toast.error(
                    permanent
                        ? `Could not restore purchase order / schedule links: ${e?.message || "not permitted"}. Please re-link manually.`
                        : "Failed to restore purchase order / schedule links after repeated attempts. Please re-link manually."
                );
                return "gave-up";
            }
            const updated = { ...pending, attempts };
            pendingAssociationRestoreRef.current = updated;
            persistPendingRestore(initialEstimate.id, updated);
            return "retrying";
        }

        const restoredLinkKeys = new Set(result.restoredLinks.map(l => `${l.estimateItemId}:${l.purchaseOrderId}`));
        const permanentPoIds = new Set(result.missing.purchaseOrderIds);
        const retryableItemIds = new Set(result.missing.itemIds);
        // A link entry is kept pending unless the server confirms it restored, or confirms its
        // PO target is permanently gone — an item reported retryable-missing always stays,
        // even if its purchaseOrderId also happens to appear in `permanentPoIds` for some OTHER
        // (already-existing) item's entry.
        const remainingLinks = pending.links.filter(l => {
            if (restoredLinkKeys.has(`${l.estimateItemId}:${l.purchaseOrderId}`)) return false;
            if (retryableItemIds.has(l.estimateItemId)) return true;
            if (permanentPoIds.has(l.purchaseOrderId)) return false;
            return true;
        });

        const restoredTaskIds = new Set(result.restoredScheduleTasks.map(t => t.scheduleTaskId));
        const permanentTaskIds = new Set(result.missing.scheduleTaskIds);
        const remainingScheduleTasks = pending.scheduleTasks.filter(st => {
            if (restoredTaskIds.has(st.scheduleTaskId)) return false;
            if (retryableItemIds.has(st.estimateItemId)) return true;
            if (permanentTaskIds.has(st.scheduleTaskId)) return false;
            return true;
        });

        if (remainingLinks.length === 0 && remainingScheduleTasks.length === 0) {
            pendingAssociationRestoreRef.current = null;
            persistPendingRestore(initialEstimate.id, null);
            return "success";
        }

        // Something is still pending (retryable). Only spend a unit of the attempt budget when
        // this call made literally zero progress (nothing restored, nothing permanently
        // resolved) — a call that DID clear some entries but left others waiting on a
        // not-yet-recreated row is forward progress, not a failure, so it shouldn't count
        // toward giving up. In practice this keeps the manual Retry / mount-recovery paths
        // (which now trigger a real row save first — see retryAssociationRestore) from burning
        // through MAX_PENDING_RESTORE_ATTEMPTS purely because a row simply isn't back yet.
        // The attempt budget exists to stop us retrying a call that keeps FAILING — not to time
        // out work the server has explicitly told us to come back for. When every remaining
        // entry is one the server reported as retryable-missing (its EstimateItem row simply
        // isn't back yet), retain the payload without spending any budget: the remedy is a
        // successful row save, which may legitimately be several user actions away, and
        // dropping the payload on a countdown would silently lose the very links this mechanism
        // exists to protect. The budget is spent only by a thrown transient failure (the catch
        // path above) or by a call that resolved nothing and explained nothing.
        const allRemainingRetryable =
            remainingLinks.every(l => retryableItemIds.has(l.estimateItemId)) &&
            remainingScheduleTasks.every(st => retryableItemIds.has(st.estimateItemId));

        const totalBefore = pending.links.length + pending.scheduleTasks.length;
        const totalAfter = remainingLinks.length + remainingScheduleTasks.length;
        const madeProgress = totalAfter < totalBefore;
        const attempts = (madeProgress || allRemainingRetryable)
            ? (pending.attempts ?? 0)
            : (pending.attempts ?? 0) + 1;

        if (!madeProgress && !allRemainingRetryable && attempts >= MAX_PENDING_RESTORE_ATTEMPTS) {
            pendingAssociationRestoreRef.current = null;
            persistPendingRestore(initialEstimate.id, null);
            toast.error("Failed to restore purchase order / schedule links after repeated attempts. Please re-link manually.");
            return "gave-up";
        }

        const updated: PendingAssociationRestore = { links: remainingLinks, scheduleTasks: remainingScheduleTasks, attempts };
        pendingAssociationRestoreRef.current = updated;
        persistPendingRestore(initialEstimate.id, updated);
        return "retrying";
    }

    // Retries a pending association restore on demand (wired to the error toast's Retry
    // action, and to the mount-time recovery effect above). Drives it through handleSave
    // rather than calling attemptPendingRestore in isolation — the actual remedy for a
    // RETRYABLE (item-missing) entry is a normal save that recreates the row, and calling the
    // restore directly (as this used to) replayed against rows that weren't back yet, which
    // read as "nothing to do" and (under the old server contract) cleared the payload for
    // good. handleSave recreates the row when there are pending changes and, once that
    // succeeds, itself runs the same replay afterward (see runSave) and returns its outcome —
    // so a caller here never duplicates that call.
    async function retryAssociationRestore() {
        if (!pendingAssociationRestoreRef.current) return;
        let status: "success" | "retrying" | "gave-up" | undefined;
        try {
            status = await handleSave({ silent: true });
        } catch {
            // The row save itself failed — runSave already toasted that error and never
            // reached the replay step (see its comment), so the pending payload is untouched.
            // Nothing further to report here.
            return;
        }
        if (status === "success") toast.success("Purchase order / schedule links restored");
        else if (status === "retrying") toast.error("Still failed to restore purchase order / schedule links — will retry on next save.");
        // "gave-up" already showed its own toast inside attemptPendingRestore; `undefined`
        // means there was nothing pending by the time runSave got there — nothing to report.
    }

    async function revertToHistory(entry: { ts: number; label: string; snapshot: any[] }) {
        const nextItems = entry.snapshot;
        const links = nextItems.flatMap((it: any) =>
            (it.purchaseOrderLinks ?? []).map((l: any) => ({ estimateItemId: it.id, purchaseOrderId: l.purchaseOrder.id, createdAt: l.createdAt }))
        );
        const scheduleTasks = nextItems
            .filter((it: any) => it.scheduleTask?.id)
            .map((it: any) => ({ scheduleTaskId: it.scheduleTask.id, estimateItemId: it.id }));
        try {
            await restoreItems({ nextItems, links, scheduleTasks, mode: "replace", label: `Before reverting to ${entry.label}` });
            setExpandedHistoryTs(null);
            toast.success(`Reverted to ${entry.label}`);
        } catch (e: any) {
            setExpandedHistoryTs(null);
            toast.error(e?.message || "Reverted locally, but failed to save — please review and save manually.", {
                action: pendingAssociationRestoreRef.current
                    ? { label: "Retry", onClick: () => retryAssociationRestore() }
                    : undefined,
            });
        }
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
                }),
            });

            if (!res.ok) {
                const data = await res.json();
                toast.error(data.error || 'AI generation failed');
                return;
            }

            const data = await res.json();
            await applyGeneratedEstimate(data, {
                verb: "AI generated",
                onMerged: () => { setShowAiModal(false); setAiPrompt(""); },
            });
        } catch (err: any) {
            console.error('AI Generate error:', err);
            toast.error(err?.message || 'Failed to generate estimate — check console');
        } finally {
            setIsGenerating(false);
        }
    }

    /**
     * Shared merge + auto-save path for a generated OR imported estimate payload
     * ({ items, paymentMilestones, count, totalEstimate }). Appends to existing items,
     * recomputes section-header totals, persists, and syncs the saved-state ref so blur
     * saves are skipped. Used by both AI generate and ChatGPT import.
     */
    async function applyGeneratedEstimate(
        data: { items?: any[]; paymentMilestones?: any[]; count?: number; totalEstimate?: number },
        { verb = "Added", onMerged }: { verb?: string; onMerged?: () => void } = {},
    ) {
        if (!data.items || data.items.length === 0) {
            toast.error('No line items found to add');
            return;
        }
        // Base off the refs, not this function's closure: the AI/import request is async, so
        // `items`/`paymentSchedules` here belong to whatever render kicked it off and may be
        // several edits stale by the time the response lands.
        const baseItems = itemsRef.current;
        const baseSchedules = fieldsRef.current.paymentSchedules;
        const newItems = [...baseItems, ...data.items];

        // Rebalance percentage-driven milestones against the post-merge total. The [total]
        // effect only repairs client state on the next render — it runs after the save below,
        // so without this the DB keeps amounts split against the pre-merge total until some
        // later save happens to correct them, and an invoice raised in between bills the
        // stale split.
        //
        // Deliberately NOT applied when the payload brings its own milestones: that appends a
        // second complete plan to the existing one, and rebalancing two 100% plans against a
        // single total over-allocates (recalcMilestoneAmounts can only clamp the last
        // residual). Normalizing or replacing there is a product decision, not a bug fix.
        const incomingMilestones = data.paymentMilestones && data.paymentMilestones.length > 0;
        const newSchedules = incomingMilestones
            ? [...baseSchedules, ...data.paymentMilestones!]
            : recalcMilestoneAmounts(baseSchedules, computeSellTotals(newItems, fieldsRef.current).total);

        // Update UI immediately — don't wait for save. itemsRef is set synchronously (not
        // just via the effect that mirrors `items`) so a save queued right behind this one
        // sees the merged items immediately, and so this save's own captureHistory call
        // records them correctly.
        itemsRef.current = newItems;
        setItems(newItems);
        // Only assigned when the payload brings milestones. On the items-only path the
        // rebalanced schedules go to the save alone: the [total] effect updates client state
        // itself, and it does so with a functional updater, so it can't clobber a schedule
        // edit that has reached state but not yet the ref.
        if (incomingMilestones) {
            setPaymentSchedules(newSchedules);
        }
        onMerged?.();
        toast.success(`${verb} ${data.count} items (est. ${formatCurrency(Number(data.totalEstimate || 0))})`);

        // Auto-save in background, routed through the same save queue as every other write
        // (see saveQueueRef comment). This used to call saveEstimate directly, bypassing the
        // queue — a save already in flight (e.g. a blur autosave) could land afterwards with
        // a stale items array and silently wipe out the just-generated/imported lines.
        setIsSaving(true); // blocks the onBlur-triggered autosave guard while this is in flight
        try {
            await handleSave({ silent: true, itemsOverride: newItems, fieldsOverride: { paymentSchedules: newSchedules } });
            toast.success("Estimate auto-saved");
        } catch (saveErr) {
            console.error("Auto-save after estimate merge failed:", saveErr);
            toast.error("Items added — but auto-save failed. Click Save to persist.");
        } finally {
            setIsSaving(false);
        }
    }

    async function handleImportEstimate() {
        const raw = importJson.trim();
        if (!raw) {
            toast.error("Paste the JSON from ChatGPT first");
            return;
        }
        let parsed: any;
        try {
            parsed = JSON.parse(raw);
        } catch {
            toast.error("That doesn't look like valid JSON. Paste ChatGPT's full output — it should start with { and end with }.");
            return;
        }
        setIsImporting(true);
        try {
            const res = await fetch('/api/ai-estimate/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    phases: parsed.phases,
                    paymentMilestones: parsed.paymentMilestones,
                    costCodes,
                }),
            });
            if (!res.ok) {
                const d = await res.json().catch(() => ({}));
                toast.error(d.error || 'Import failed — check the JSON format');
                return;
            }
            const data = await res.json();
            await applyGeneratedEstimate(data, {
                verb: "Imported",
                onMerged: () => { setShowImportModal(false); setImportJson(""); },
            });
        } catch (err: any) {
            console.error('Import estimate error:', err);
            toast.error(err?.message || 'Failed to import estimate');
        } finally {
            setIsImporting(false);
        }
    }

    /**
     * Keyed by stable item id (not index) + a patch object. Several callers (BudgetStrip's rate
     * and margin inputs) fire two or three field updates from one event — the patch object is
     * what makes that safe: building each field update from the render-closure `items` made
     * each call overwrite the previous, so a rate edit persisted only markupPercent and a margin
     * edit only baseCost, with the rest silently dropped.
     *
     * id-keying (not index) is also what survives reorder/delete mid-flight: callers that
     * resolve their row BEFORE an await (AI description fill, approve/reject) can have rows
     * reordered, added or deleted while the request is in flight, so a position captured
     * beforehand may point at a different row — or past the end — by the time the updater runs.
     * Matching on id is stable across all of those, matching applyPoLinkChange's reasoning.
     *
     * Functional updater + in-updater itemsRef sync so a save queued right behind this one sees
     * the change immediately, not on the next render's effect.
     */
    function updateItem(itemId: string, patch: Record<string, any>) {
        setItems(prev => {
            const next = prev.map(it => (it.id === itemId ? { ...it, ...patch } : it));
            itemsRef.current = next;
            return next;
        });
    }

    // Re-inserts each removed row at its original index, for the case where other edits
    // happened to `current` while the undo toast was up (so we can't just restore `preDelete`
    // wholesale — that would also discard those other edits).
    function spliceBackByIndex(current: any[], removed: Array<{ item: any; index: number }>) {
        const next = [...current];
        const sorted = [...removed].sort((a, b) => a.index - b.index);
        for (const { item, index } of sorted) {
            next.splice(Math.min(index, next.length), 0, item);
        }
        return next;
    }

    function removeItem(index: number) {
        const itemToRemove = items[index];
        const children = items.filter(i => i.parentId === itemToRemove.id);
        const group = [itemToRemove, ...children];

        // B1: block outright if the item or any sub-item has logged time/expenses —
        // saveEstimate hard-rejects deleting those server-side, so a local delete here
        // would just wedge the editor unable to save.
        const hasProtectedData = group.some(it => (it._count?.timeEntries ?? 0) > 0 || (it.expenses?.length ?? 0) > 0);
        if (hasProtectedData) {
            toast.error(`"${itemToRemove.name || "This item"}" can't be deleted — it has logged time entries or expenses attached. Remove those first.`);
            return;
        }

        // B1: confirm if PO links or a schedule task would be severed.
        const poLinks = group.flatMap(it => it.purchaseOrderLinks ?? []);
        const scheduleTasks = group.filter(it => it.scheduleTask);
        if (poLinks.length > 0 || scheduleTasks.length > 0) {
            const parts: string[] = [];
            if (poLinks.length > 0) parts.push(`${poLinks.length} purchase order${poLinks.length !== 1 ? "s" : ""}`);
            if (scheduleTasks.length > 0) parts.push(`${scheduleTasks.length} schedule task${scheduleTasks.length !== 1 ? "s" : ""}`);
            const ok = window.confirm(`"${itemToRemove.name || "This item"}" has ${parts.join(" and ")} attached. Delete anyway?`);
            if (!ok) return;
        }

        captureHistory(`Before deleting "${itemToRemove.name || "item"}"`);
        const preDelete = items;
        const postDelete = items.filter((it, i) => i !== index && it.parentId !== itemToRemove.id);
        const removed = group.map(it => ({ item: it, index: items.indexOf(it) }));
        setItems(postDelete);
        itemsRef.current = postDelete;

        toast(`Deleted "${itemToRemove.name || "item"}"${children.length ? ` and ${children.length} sub-item(s)` : ""}`, {
            action: { label: "Undo", onClick: () => undoDelete({ preDelete, postDelete, removed }) },
            duration: 10000,
        });
    }

    async function undoDelete({ preDelete, postDelete, removed }: {
        preDelete: any[];
        postDelete: any[];
        removed: Array<{ item: any; index: number }>;
    }) {
        // Compute nextItems synchronously from itemsRef.current — the canonical current
        // state — BEFORE calling setItems. A functional setItems(current => ...) updater is
        // not guaranteed to run before this handler continues (React can defer it to the
        // render phase), so extracting the computed array out of the updater via a captured
        // variable previously reached restoreItems as `[]`, which saveEstimate interprets as
        // "delete every line item" — a catastrophic false undo. itemsRef.current is safe to
        // read here directly because it was set synchronously in removeItem right after the
        // delete (and by restoreItems on every prior restore), so it always reflects the
        // actual current items regardless of render timing.
        const current = itemsRef.current;
        const nextItems = current === postDelete ? preDelete : spliceBackByIndex(current, removed);

        const links = removed.flatMap(r =>
            (r.item.purchaseOrderLinks ?? []).map((l: any) => ({ estimateItemId: r.item.id, purchaseOrderId: l.purchaseOrder.id, createdAt: l.createdAt }))
        );
        const scheduleTasks = removed
            .filter(r => r.item.scheduleTask?.id)
            .map(r => ({ scheduleTaskId: r.item.scheduleTask.id, estimateItemId: r.item.id }));

        try {
            await restoreItems({
                nextItems, links, scheduleTasks, mode: "additive",
                label: `Before undoing delete of "${removed[0]?.item?.name || "item"}"`,
            });
            toast.success("Item restored");
        } catch (e: any) {
            toast.error(e?.message || "Restored locally, but failed to save — please review and save manually.", {
                action: pendingAssociationRestoreRef.current
                    ? { label: "Retry", onClick: () => retryAssociationRestore() }
                    : undefined,
            });
        }
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

    // Appends/removes a single item's purchaseOrderLinks inside one functional setItems
    // update, deduplicated by PO id. Rapid-fire clicks (link A, then B, then C before any
    // request resolves) each call this from their own event handler with whatever `items`
    // their render closure captured — reading/writing through the closure directly would
    // have each call overwrite the others' additions with a stale array. Routing every
    // mutation through the same functional updater means each one applies on top of
    // whatever the previous one just committed, and itemsRef is kept in sync inside the
    // same update (not via the separate effect, which could still be pending).
    function applyPoLinkChange(itemId: string, mutate: (links: any[]) => any[]) {
        setItems(prev => {
            const next = prev.map((it: any) => {
                if (it.id !== itemId) return it;
                return { ...it, purchaseOrderLinks: mutate(it.purchaseOrderLinks ?? []) };
            });
            itemsRef.current = next;
            return next;
        });
    }

    async function handleSelectPO(itemId: string, po: any) {
        try {
            await linkPOToEstimateItem(itemId, po.id);
            applyPoLinkChange(itemId, links =>
                links.some((l: any) => l.purchaseOrder.id === po.id) ? links : [...links, { purchaseOrder: po }]
            );
            toast.success(`Linked ${po.code}`);
        } catch (err: any) { toast.error(err.message); }
    }

    async function handleUnlinkPO(itemId: string, poId: string) {
        try {
            await unlinkPOFromEstimateItem(itemId, poId);
            applyPoLinkChange(itemId, links => links.filter((l: any) => l.purchaseOrder.id !== poId));
            // Supersede: this is a deliberate, explicit user action — if some earlier undo/
            // revert still has this exact (item, PO) pair queued for restore, that queued
            // restore must not be allowed to replay it back in on the next save.
            const updated = removePendingLinks(pendingAssociationRestoreRef.current, [{ estimateItemId: itemId, purchaseOrderId: poId }]);
            if (updated !== pendingAssociationRestoreRef.current) {
                pendingAssociationRestoreRef.current = updated;
                persistPendingRestore(initialEstimate.id, updated);
            }
            toast.success("PO unlinked");
        } catch (err: any) { toast.error(err.message); }
    }

    function handlePOCreated(itemId: string, po: any) {
        applyPoLinkChange(itemId, links =>
            links.some((l: any) => l.purchaseOrder.id === po.id) ? links : [...links, { purchaseOrder: po }]
        );
    }

    async function handleAiFillAll({ overwriteExisting: overwrite }: { overwriteExisting: boolean }) {
        // Only leaf items (no children) are eligible — section headers are skipped.
        const leafItems = items.filter(item => {
            if (!item.parentId && items.some((i: any) => i.parentId === item.id)) return false;
            return true;
        });

        // Lock partition. PO-locked items are ALWAYS skipped regardless of overwrite flag —
        // a cut purchase order is a real dollar commitment, not a suggestion.
        const isPoLocked = (it: any) => (it.purchaseOrderLinks?.length ?? 0) > 0;
        const hasBudget = (it: any) => {
            const n = parseFloat(it.budgetRate);
            return Number.isFinite(n) && n > 0;
        };

        const poLocked = leafItems.filter(isPoLocked);
        const eligible = leafItems.filter(it => !isPoLocked(it));
        const toSend = overwrite ? eligible : eligible.filter(it => !hasBudget(it));
        const lockedForThisRun = eligible.filter(it => !toSend.includes(it)).concat(poLocked);

        if (toSend.length === 0) {
            toast.info("No items to fill — all budgets are set. Enable Overwrite to regenerate.");
            return;
        }

        // Aggregate locked contributions so AI can distribute remaining margin correctly.
        let lockedSell = 0;
        let lockedBudget = 0;
        for (const it of lockedForThisRun) {
            const qty = parseFloat(it.quantity) || 0;
            const price = parseFloat(it.unitCost) || 0;
            const rate = parseFloat(it.budgetRate);
            lockedSell += qty * price;
            // PO-locked item with no recorded budget: treat its committed cost as sell (0% margin)
            // so the AI distributes the rest against a conservative baseline.
            lockedBudget += Number.isFinite(rate) && rate > 0 ? qty * rate : qty * price;
        }

        const tgt = Math.max(0, Math.min(70, parseFloat(targetMargin) || 25));

        setIsAiFilling(true);
        try {
            const res = await fetch("/api/ai-estimate/budget-fill", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    items: toSend.map(i => {
                        const qty = parseFloat(i.quantity) || 1;
                        const price = parseFloat(i.unitCost) || 0;
                        return {
                            id: i.id,
                            name: i.name || "",
                            description: i.description || "",
                            type: i.type || "Material",
                            quantity: qty,
                            unitCost: price,
                            lineTotal: qty * price,
                        };
                    }),
                    lockedContributions: { totalSellAmount: lockedSell, totalBudgetAmount: lockedBudget },
                    targetMarginPercent: tgt,
                    projectContext: `${context.name} (${context.type})`,
                    location: context.location || "Vancouver, WA",
                }),
            });
            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || "AI budget fill failed");
            }
            const { suggestions, notes } = await res.json();

            // Client-side enforcement guard: only apply suggestions for items we actually sent.
            // Drops stray/hallucinated IDs and any attempt by AI to touch a locked item.
            const sendableIds = new Set(toSend.map(i => i.id));
            const validSuggestions = (suggestions || []).filter((s: any) => sendableIds.has(s.id));

            // First pass: apply raw AI budgetRates, mirror sell quantity, derive margin.
            // Track newly-filled item IDs so we can rescale them in the second pass.
            const newlyFilledIds = new Set<string>(validSuggestions.map((s: any) => s.id));
            let filled = 0;

            setItems(prev => {
                const next = prev.map(item => ({ ...item }));

                for (const s of validSuggestions) {
                    const idx = next.findIndex((i: any) => i.id === s.id);
                    if (idx < 0) continue;
                    const rate = Math.max(0, parseFloat(s.budgetRate) || 0);
                    const sellQty = parseFloat(next[idx].quantity) || 0;
                    const sellPrice = parseFloat(next[idx].unitCost) || 0;
                    next[idx] = {
                        ...next[idx],
                        budgetRate: rate > 0 ? String(rate) : null,
                        baseCost: rate > 0 ? String(rate) : null,
                        budgetUnit: s.budgetUnit || next[idx].budgetUnit,
                        budgetQuantity: sellQty,
                        markupPercent: derivedMarginPct(rate, sellPrice),
                        // DO NOT touch: unitCost, quantity, total, purchaseOrderLinks
                    };
                    filled++;
                }

                // Second pass: post-AI rescale to force target margin.
                // LLMs don't reliably hit weighted targets — scale newly-filled budgetRates
                // proportionally so (lockedBudget + newAiBudget) / grandSell hits target.
                const grandSell = lockedSell + next.reduce((sum, it) => {
                    if (!newlyFilledIds.has(it.id)) return sum;
                    const q = parseFloat(it.quantity) || 0;
                    const p = parseFloat(it.unitCost) || 0;
                    return sum + q * p;
                }, 0);
                const targetBudgetTotal = grandSell * (1 - tgt / 100);
                const neededFromAi = Math.max(0, targetBudgetTotal - lockedBudget);
                const actualAiBudget = next.reduce((sum, it) => {
                    if (!newlyFilledIds.has(it.id)) return sum;
                    const q = parseFloat(it.quantity) || 0;
                    const r = parseFloat(it.budgetRate);
                    return sum + (Number.isFinite(r) ? q * r : 0);
                }, 0);

                let scale = actualAiBudget > 0 ? neededFromAi / actualAiBudget : 1;
                let clamped = false;
                if (scale < 0.3) { scale = 0.3; clamped = true; }
                if (scale > 3.0) { scale = 3.0; clamped = true; }

                if (Math.abs(scale - 1) > 0.005 && scale > 0) {
                    for (let idx = 0; idx < next.length; idx++) {
                        if (!newlyFilledIds.has(next[idx].id)) continue;
                        const r = parseFloat(next[idx].budgetRate);
                        if (!Number.isFinite(r) || r <= 0) continue;
                        const sellPrice = parseFloat(next[idx].unitCost) || 0;
                        // Don't let rescale push budget above sell (would invert margin).
                        let newRate = r * scale;
                        if (sellPrice > 0 && newRate >= sellPrice) newRate = sellPrice * 0.99;
                        if (newRate < 0) newRate = 0;
                        next[idx] = {
                            ...next[idx],
                            budgetRate: newRate > 0 ? String(newRate) : null,
                            baseCost: newRate > 0 ? String(newRate) : null,
                            markupPercent: derivedMarginPct(newRate, sellPrice),
                        };
                    }
                    if (clamped) {
                        // Schedule warning after state commit
                        setTimeout(() => toast.warning("Margin target approximated — AI estimate was far off"), 0);
                    }
                }

                // Compute actual weighted margin for the toast (client-computed, not AI-reported).
                let totalSell = 0;
                let totalBudget = 0;
                for (const it of next) {
                    const q = parseFloat(it.quantity) || 0;
                    const p = parseFloat(it.unitCost) || 0;
                    const r = parseFloat(it.budgetRate);
                    // Only count leaf items (same filter as above) in the margin total.
                    const isLeaf = !(!it.parentId && next.some((c: any) => c.parentId === it.id));
                    if (!isLeaf) continue;
                    totalSell += q * p;
                    if (Number.isFinite(r) && r > 0) totalBudget += q * r;
                }
                const actualMargin = totalSell > 0 ? ((totalSell - totalBudget) / totalSell) * 100 : 0;

                // Schedule toast after state commit
                setTimeout(() => {
                    const base = `AI filled ${filled} budget${filled !== 1 ? "s" : ""} — margin ${actualMargin.toFixed(1)}% (target ${tgt}%)`;
                    toast.success(notes ? `${base}\n${notes}` : base);
                }, 0);

                return next;
            });
        } catch (err: any) {
            toast.error(err.message || "AI budget fill failed");
        } finally {
            setIsAiFilling(false);
        }
    }

    function handleClearBudgets() {
        if (!window.confirm("Clear all budget values? Items with purchase orders will be preserved.")) return;
        const resetMargin = Math.max(0, Math.min(70, parseFloat(targetMargin) || 25));
        setItems(prev => prev.map(it => {
            if ((it.purchaseOrderLinks?.length ?? 0) > 0) return it;               // PO-locked, never touch
            if (!it.parentId && prev.some((c: any) => c.parentId === it.id)) return it; // category header
            return {
                ...it,
                budgetRate: null,
                baseCost: null,
                budgetQuantity: null,
                budgetUnit: null,
                markupPercent: resetMargin,
                // unitCost/quantity/total untouched
            };
        }));
        toast.success("Budgets cleared — PO-committed items kept");
    }

    async function handleAiAssignPhases() {
        const eligibleItems = items.filter((_item, index) => !itemTotals[index].isSection);

        if (eligibleItems.length === 0) {
            toast.info("No items found to assign phases.");
            return;
        }

        setIsAiAssigningPhases(true);
        try {
            const payloadItems = eligibleItems.map(item => ({
                id: item.id,
                name: item.name,
                description: item.description || ""
            }));

            const payloadCostCodes = costCodes.map(cc => ({
                id: cc.id,
                code: cc.code,
                name: cc.name
            }));

            const res = await fetch("/api/ai-estimate/assign-phases", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    items: payloadItems,
                    costCodes: payloadCostCodes
                })
            });

            if (!res.ok) {
                const errData = await res.json();
                throw new Error(errData.error || "Failed to auto-assign phases");
            }

            const { assignments } = await res.json();
            if (!assignments || !Array.isArray(assignments)) {
                throw new Error("Invalid response from server");
            }

            let assignedCount = 0;
            setItems(prev => {
                const next = [...prev];
                for (const ass of assignments) {
                    const idx = next.findIndex(item => item.id === ass.id);
                    if (idx >= 0 && ass.costCodeId !== undefined) {
                        next[idx] = { ...next[idx], costCodeId: ass.costCodeId };
                        assignedCount++;
                    }
                }
                return next;
            });

            toast.success(`Successfully matched and assigned phases to ${assignedCount} items.`);
        } catch (err: any) {
            console.error("Auto-assign phases error:", err);
            toast.error(err.message || "Failed to auto-assign phases");
        } finally {
            setIsAiAssigningPhases(false);
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
            newSchedules[index] = { ...newSchedules[index], percentage: value };
            const recalced = recalcMilestoneAmounts(newSchedules, total);
            setPaymentSchedules(recalced);
            return;
        } else if (field === "amount") {
            newSchedules[index] = {
                ...newSchedules[index],
                amount: value,
                percentage: ""
            };
        } else {
            newSchedules[index] = {
                ...newSchedules[index],
                [field]: value
            };
        }
        setPaymentSchedules(newSchedules);
    }

    function handleAmountBlur() {
        setPaymentSchedules(prev => {
            const recalced = recalcMilestoneAmounts(prev, total);
            const changed = recalced.some((s, i) => s.amount !== prev[i].amount);
            return changed ? recalced : prev;
        });
    }

    function removePaymentSchedule(index: number) {
        // Invoice-side milestones are snapshots — deleting the estimate copy does
        // NOT remove it from an already-generated invoice.
        if (linkedInvoice) {
            const ok = window.confirm(
                `This estimate has already been invoiced (${linkedInvoice.code}). ` +
                `Deleting this milestone will NOT remove it from the invoice — ` +
                `the invoice must be adjusted separately. Delete anyway?`
            );
            if (!ok) return;
        }
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
                if (!e.currentTarget.contains(e.relatedTarget as Node) && !showTemplateModal && !showAiModal && !showImportModal && !showSendModal && !showMoreMenu && !isSaving && !isSyncingQB && !saveConflictRef.current) {
                    handleSave();
                }
            }}
        >
            {/* Top Navigation / Action Bar */}
            {/* z-30: must beat the sidebar's sticky tab bar (z-10, later in DOM) so the ⋮ dropdown isn't painted under it */}
            <div className="bg-white border-b border-hui-border px-4 py-3 flex items-center justify-between shadow-sm z-30 sticky top-0">
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
                    {showTaxCertWarning && (
                        <button
                            onClick={() => router.push(taxCertFixHref)}
                            title="This estimate is tax-exempt but the client has no valid exemption certificate on file. WA DOR requires one for every exempt sale. Click to open the client record."
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold border transition ${taxCertStatus === "expired" ? "bg-red-50 text-red-700 border-red-200 hover:bg-red-100" : "bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100"}`}
                        >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M5.07 19h13.86c1.54 0 2.5-1.67 1.73-3L13.73 4c-.77-1.33-2.69-1.33-3.46 0L3.34 16c-.77 1.33.19 3 1.73 3z" /></svg>
                            {taxCertStatus === "expired" ? "Tax-exempt cert expired" : "No tax-exempt cert on file"}
                        </button>
                    )}
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
                                        onClick={() => { setShowImportModal(true); setShowMoreMenu(false); }}
                                        className="w-full text-left px-4 py-2.5 hover:bg-purple-50 flex items-center gap-2.5 text-purple-700"
                                    >
                                        <svg className="w-4 h-4 text-purple-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10" /></svg>
                                        Import from ChatGPT
                                    </button>
                                    <button
                                        onClick={() => { handleAiAssignPhases(); setShowMoreMenu(false); }}
                                        disabled={isAiAssigningPhases}
                                        className="w-full text-left px-4 py-2.5 hover:bg-purple-50 flex items-center gap-2.5 text-purple-700 disabled:opacity-50"
                                    >
                                        <svg className={`w-4 h-4 text-purple-500 ${isAiAssigningPhases ? "animate-pulse" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                                        {isAiAssigningPhases ? "Assigning..." : "Auto-assign Phases"}
                                    </button>
                                    <button
                                        onClick={() => { handleHistoricalPricing(); setShowMoreMenu(false); }}
                                        disabled={isLoadingHistorical}
                                        className="w-full text-left px-4 py-2.5 hover:bg-teal-50 flex items-center gap-2.5 text-teal-700 disabled:opacity-50"
                                    >
                                        <svg className="w-4 h-4 text-teal-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
                                        {isLoadingHistorical ? "Analyzing..." : "Historical Pricing"}
                                    </button>
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
                    {/* isSyncingQB: the pre-sync save inside handleSyncQB runs silently, so isSaving
                        stays false — without it this button would invite a second save that could
                        land in the middle of the sync. */}
                    <button
                        onClick={() => handleSave()}
                        disabled={isSaving || isSyncingQB}
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
                    <div className="bg-white rounded-xl shadow-2xl p-6 w-full max-w-sm mx-4" onClick={e => e.stopPropagation()}>
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

            <div className="flex-1 flex flex-col lg:flex-row overflow-y-auto lg:overflow-hidden">
            <div className="flex-1 p-4 lg:p-8 flex justify-center pb-24 overflow-visible lg:overflow-y-auto">
                {activeTab === "builder" && (
                    <div className="w-full max-w-5xl">
                        {/* Premium Document Wrapper */}
                        <div className="bg-white rounded-xl shadow-[0_8px_30px_rgb(0,0,0,0.04)] border border-slate-200 overflow-hidden relative">
                            {/* Subtle Gradient Accent Top Line */}
                            <div className="h-1.5 w-full bg-slate-800"></div>

                            {/* Internal-only: Budget fill control cluster */}
                            {viewMode === "internal" && (
                                <div className="px-10 py-4 bg-indigo-50/40 border-b border-indigo-100 flex flex-wrap items-center gap-4">
                                    <div className="flex items-center gap-2">
                                        <label htmlFor="targetMargin" className="text-xs font-semibold uppercase tracking-wider text-indigo-700">Target margin</label>
                                        <div className="relative">
                                            <input
                                                id="targetMargin"
                                                type="number"
                                                min={0}
                                                max={70}
                                                step={1}
                                                value={targetMargin}
                                                onChange={e => setTargetMargin(e.target.value)}
                                                className="w-20 px-2 py-1.5 pr-6 text-sm font-semibold text-slate-800 bg-white border border-indigo-200 rounded focus:outline-none focus:ring-2 focus:ring-indigo-300"
                                            />
                                            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-slate-500 pointer-events-none">%</span>
                                        </div>
                                    </div>
                                    <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer select-none" title="PO-committed items are always protected regardless of this setting.">
                                        <input
                                            type="checkbox"
                                            checked={overwriteExisting}
                                            onChange={e => setOverwriteExisting(e.target.checked)}
                                            className="w-4 h-4 rounded border-indigo-300 text-indigo-600 focus:ring-indigo-300"
                                        />
                                        Overwrite existing budgets
                                    </label>
                                    <div className="flex-1" />
                                    <button
                                        onClick={() => handleAiFillAll({ overwriteExisting })}
                                        disabled={isAiFilling}
                                        className="hui-btn hui-btn-primary text-sm flex items-center gap-2 disabled:opacity-50"
                                        title="AI distributes budgets across items so overall margin lands on the target."
                                    >
                                        <svg className={`w-4 h-4 ${isAiFilling ? "animate-pulse" : ""}`} viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61z" /></svg>
                                        {isAiFilling ? "Filling…" : "AI fill budgets"}
                                    </button>
                                    <button
                                        onClick={handleAiAssignPhases}
                                        disabled={isAiAssigningPhases || isAiFilling}
                                        className="hui-btn hui-btn-secondary text-sm flex items-center gap-2 disabled:opacity-50"
                                        title="Auto-assign phases using AI."
                                    >
                                        <svg className={`w-4 h-4 text-purple-500 ${isAiAssigningPhases ? "animate-pulse" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                                        {isAiAssigningPhases ? "Assigning..." : "Auto-assign Phases"}
                                    </button>
                                    <button
                                        onClick={handleClearBudgets}
                                        disabled={isAiFilling}
                                        className="hui-btn hui-btn-secondary text-sm text-red-600 hover:text-red-700 disabled:opacity-50"
                                        title="Clear all budget values (PO-committed items are preserved)."
                                    >
                                        Clear budgets
                                    </button>
                                </div>
                            )}

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
                                                const isSection = sectionIds.has(item.id);
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
                                                                        <input type="text" value={item.name} onChange={e => updateItem(item.id, { name: e.target.value })}
                                                                            placeholder="Category name"
                                                                            className="w-full bg-transparent focus:outline-none focus:bg-white focus:ring-1 ring-hui-border rounded px-2 py-0.5 font-semibold text-sm text-hui-textMain"
                                                                        />
                                                                        <div className="flex items-center gap-3 mt-0.5 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto transition-opacity duration-150 [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto">
                                                                            <button onClick={() => addSubItem(index)} className="text-[10px] text-hui-primary hover:text-hui-primaryHover font-medium focus-visible:opacity-100">+ Add Sub-item</button>
                                                                            <button onClick={() => addCategoryAfter(index + items.filter(i => i.parentId === item.id).length)} className="text-[10px] text-slate-400 hover:text-slate-600 font-medium focus-visible:opacity-100">+ Add Category Below</button>
                                                                        </div>
                                                                    </div>
                                                                    <div className="flex items-center gap-3 ml-auto">
                                                                        {isCollapsed && <span className="text-xs text-slate-400">{items.filter((i: any) => i.parentId === item.id).length} items</span>}
                                                                        <span className="text-sm font-semibold text-slate-700 w-28 text-right">{formatCurrency(sectionTotal)}</span>
                                                                        <button onClick={() => removeItem(index)} className="w-7 h-7 flex items-center justify-center rounded text-slate-300 hover:text-red-500 hover:bg-red-50 transition opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto">
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
                                                                        onChange={e => updateItem(item.id, { name: e.target.value })}
                                                                        placeholder="Item name"
                                                                        className={`flex-1 min-w-0 bg-transparent focus:outline-none focus:bg-white focus:ring-1 ring-hui-border rounded px-2 py-1 transition text-sm ${isSubItem ? 'text-hui-textMuted' : 'font-medium text-hui-textMain'}`}
                                                                    />
                                                                    <div className="w-20 px-2 text-right flex-shrink-0">
                                                                        <input
                                                                            type="number"
                                                                            value={item.quantity}
                                                                            onChange={e => updateItem(item.id, { quantity: e.target.value })}
                                                                            className="w-full bg-transparent focus:outline-none focus:bg-white focus:ring-1 ring-slate-200 rounded px-2 py-1 text-right hover:bg-slate-50 transition text-sm font-medium text-slate-700"
                                                                        />
                                                                    </div>
                                                                    {/* In internal view the price follows from cost + margin, so a row with a
                                                                        budget rate locks it. But a row with no valid sell price has a disabled
                                                                        margin input telling the user to enter one — locking the price too would
                                                                        make that instruction unfollowable and trap the row. Unlock exactly
                                                                        those rows, and keep them unlocked for the whole repair (see
                                                                        repairingSellPriceItemId) so a half-typed value can't relock the field. */}
                                                                    {(() => { const isLocked = viewMode === "internal" && !!(item.budgetRate ?? item.baseCost) && marginIsSettable(parseFloat(item.unitCost) || 0) && repairingSellPriceItemId !== item.id; return (
                                                                    <div className="w-28 px-2 flex items-center justify-end flex-shrink-0">
                                                                        <span className={`text-sm flex-shrink-0 ${isLocked ? "text-slate-300" : "text-slate-400"}`}>$</span>
                                                                        <input
                                                                            type="number"
                                                                            value={item.unitCost}
                                                                            onChange={e => {
                                                                                // Margin is derived from the cost/price pair, so moving the price
                                                                                // has to move the margin with it. Without this, price 100 -> 200
                                                                                // left rate 75 sitting next to a stored 25% while the line was
                                                                                // really running 62.5%. The rate is NOT touched — the budget cost
                                                                                // is unchanged by a price edit.
                                                                                // No budget rate means there is no derived margin to keep in sync,
                                                                                // and a price edit is not the place to clear one.
                                                                                const rate = parseFloat(item.budgetRate ?? item.baseCost ?? "") || 0;
                                                                                updateItem(item.id, {
                                                                                    unitCost: e.target.value,
                                                                                    ...(rate > 0 ? marginPatchForRate(rate, parseFloat(e.target.value) || 0) : {}),
                                                                                });
                                                                            }}
                                                                            onFocus={() => {
                                                                                // Entering repair mode only matters for a row that is currently
                                                                                // unlocked BECAUSE its sell price is invalid — a normally locked
                                                                                // row is readOnly and never receives focus this way anyway.
                                                                                if (!marginIsSettable(parseFloat(item.unitCost) || 0)) setRepairingSellPriceItemId(item.id);
                                                                            }}
                                                                            onBlur={() => setRepairingSellPriceItemId(prev => (prev === item.id ? null : prev))}
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
                                                                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-green-50 text-green-700 border border-green-200 cursor-pointer" onClick={async () => { await updateItemApproval(item.id, null); updateItem(item.id, { approvalStatus: null }); }}>
                                                                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                                                                                Approved
                                                                            </span>
                                                                        ) : item.approvalStatus === "rejected" ? (
                                                                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-red-50 text-red-700 border border-red-200 cursor-pointer" onClick={async () => { await updateItemApproval(item.id, null); updateItem(item.id, { approvalStatus: null }); }}>
                                                                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                                                                                Rejected
                                                                            </span>
                                                                        ) : (
                                                                            <span className="opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto transition flex gap-0.5 [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto">
                                                                                <button onClick={async () => { await updateItemApproval(item.id, "approved"); updateItem(item.id, { approvalStatus: "approved" }); toast.success("Item approved"); }} className="p-1 rounded hover:bg-green-50 text-slate-400 hover:text-green-600 transition focus-visible:opacity-100 focus-visible:pointer-events-auto" title="Approve">
                                                                                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                                                                                </button>
                                                                                <button onClick={async () => { await updateItemApproval(item.id, "rejected"); updateItem(item.id, { approvalStatus: "rejected" }); toast.success("Item rejected"); }} className="p-1 rounded hover:bg-red-50 text-slate-400 hover:text-red-500 transition focus-visible:opacity-100 focus-visible:pointer-events-auto" title="Reject">
                                                                                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                                                                                </button>
                                                                            </span>
                                                                        )}
                                                                        <button onClick={() => removeItem(index)} className="opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto text-slate-300 hover:text-red-500 hover:bg-red-50 rounded p-1 transition">
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
                                                                                updateItem(item.id, { description: e.target.value });
                                                                                autoExpand(e.target);
                                                                            }}
                                                                            onInput={e => autoExpand(e.target as HTMLTextAreaElement)}
                                                                            placeholder="Add description..."
                                                                            rows={1}
                                                                            className="flex-1 bg-transparent focus:outline-none focus:bg-white focus:ring-1 ring-hui-border rounded px-2 py-0.5 transition text-xs text-hui-textMuted resize-none overflow-hidden"
                                                                        />
                                                                        {item.name?.trim() && (
                                                                            <button
                                                                                onClick={() => suggestDescription(item.id)}
                                                                                disabled={aiSuggestingDesc === item.id}
                                                                                title="AI: suggest description"
                                                                                className="flex-shrink-0 mt-0.5 p-0.5 rounded text-amber-400 hover:text-amber-600 hover:bg-amber-50 transition disabled:opacity-50 disabled:animate-pulse opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto"
                                                                            >
                                                                                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2z"/></svg>
                                                                            </button>
                                                                        )}
                                                                    </div>
                                                                    {/* Phase/Type pills + action buttons — hover only */}
                                                                    <div className="flex items-center gap-2 mt-1 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto transition-opacity duration-150 [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto">
                                                                        <select
                                                                            value={item.costCodeId || ""}
                                                                            onChange={e => updateItem(item.id, { costCodeId: e.target.value || null })}
                                                                            className="bg-slate-100 hover:bg-slate-200 focus:bg-white focus:ring-1 ring-hui-border text-hui-textMuted text-[11px] rounded-full px-2.5 py-0.5 border-0 focus:outline-none cursor-pointer transition"
                                                                        >
                                                                            <option value="">Phase</option>
                                                                            {costCodes.map(cc => (
                                                                                <option key={cc.id} value={cc.id}>{cc.code}</option>
                                                                            ))}
                                                                        </select>
                                                                        <select
                                                                            value={ITEM_TYPE_LABELS.includes(item.type) ? item.type : ""}
                                                                            onChange={e => {
                                                                                const label = e.target.value;
                                                                                if (!label) return;
                                                                                // One atomic update: set the label and drop any stale CostType link.
                                                                                setItems(prev => prev.map((it, i) => i === index ? { ...it, type: label, costTypeId: null } : it));
                                                                            }}
                                                                            className={`hover:bg-slate-200 focus:bg-white focus:ring-1 ring-hui-border text-[11px] rounded-full px-2.5 py-0.5 border-0 focus:outline-none cursor-pointer transition ${
                                                                                item.type === 'Allowance'
                                                                                    ? 'bg-amber-100 text-amber-700 font-semibold'
                                                                                    : 'bg-slate-100 text-hui-textMuted'
                                                                            }`}
                                                                        >
                                                                            <option value="">Type</option>
                                                                            {ITEM_TYPE_LABELS.map(label => (
                                                                                <option key={label} value={label}>{label}</option>
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
                                                                                onClick={() => suggestSubitems(item.id)}
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
                                                                    updateItem={updateItem}
                                                                    contextType={context.type}
                                                                    onLinkPO={handleLinkPO}
                                                                    onCreatePO={(id) => setPOCreateItemId(id)}
                                                                    onUnlinkPO={handleUnlinkPO}
                                                                    onViewPO={(poId) => window.open(`/projects/${context.id}/purchase-orders/${poId}`, "_blank")}
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
                                {linkedInvoice && (
                                    <div className="flex items-start gap-2.5 bg-amber-50 border-b border-amber-200 px-8 py-3">
                                        <svg className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                                        </svg>
                                        <p className="text-xs text-amber-800">
                                            <span className="font-semibold">This estimate has been invoiced ({linkedInvoice.code}).</span>{" "}
                                            Adding, editing, or deleting milestones here does <strong>not</strong> update the invoice — align the invoice&apos;s payment schedule separately.
                                        </p>
                                    </div>
                                )}
                                <div className="flex text-[11px] font-bold text-slate-400 bg-white border-b border-slate-100 px-8 py-3 uppercase tracking-wider">
                                    <div className="flex-1">Payment Name</div>
                                    <div className="w-32">Percentage</div>
                                    <div className="w-32">Amount</div>
                                    <div className="w-40 text-right">Due Date</div>
                                    <div className="w-32 text-right">Status</div>
                                    <div className="w-10"></div>
                                </div>
                                <div className="divide-y divide-slate-50">
                                    {paymentSchedules.map((schedule, index) => {
                                        const isPaid = schedule.status === "Paid";
                                        const paidOn = schedule.paidAt || schedule.paymentDate;
                                        const isSavedSchedule = !!schedule.id && savedScheduleIds.has(schedule.id);
                                        const methodLabel = formatEstPaymentMethod(schedule.paymentMethod, schedule.referenceNumber);
                                        return (
                                        <div key={schedule.id || index} className={`flex items-center px-8 py-4 transition-colors border-l-4 ${isPaid ? 'bg-green-50/60 border-green-400' : 'bg-white hover:bg-slate-50/50 border-transparent group'}`}>
                                            <div className="flex-1">
                                                <input
                                                    type="text"
                                                    value={schedule.name}
                                                    onChange={e => updatePaymentSchedule(index, "name", e.target.value)}
                                                    placeholder="e.g. Initial Deposit"
                                                    disabled={isPaid}
                                                    className="w-full bg-transparent focus:outline-none focus:bg-white focus:ring-1 ring-slate-200 rounded px-3 py-1.5 -ml-3 transition-all text-sm font-semibold text-slate-800 disabled:cursor-default"
                                                />
                                                {isPaid && methodLabel && (
                                                    <div className="text-[11px] text-slate-400 mt-0.5 ml-0">{methodLabel}</div>
                                                )}
                                            </div>
                                            <div className="w-32 px-4 relative">
                                                <input
                                                    type="number"
                                                    value={schedule.percentage || (total > 0 && schedule.amount ? String(rm(((parseFloat(schedule.amount) || 0) / total) * 100)) : "")}
                                                    onChange={e => updatePaymentSchedule(index, "percentage", e.target.value)}
                                                    placeholder="%"
                                                    disabled={isPaid}
                                                    className={`w-full bg-transparent focus:outline-none focus:bg-white focus:ring-1 ring-slate-200 rounded px-3 py-1.5 pr-6 transition-all text-sm font-medium disabled:cursor-default ${!schedule.percentage && schedule.amount ? 'text-slate-300 italic' : 'text-slate-600'}`}
                                                />
                                                <span className="absolute right-7 top-2 text-slate-400 text-xs">%</span>
                                            </div>
                                            <div className="w-32 px-4 relative">
                                                {isPaid ? (
                                                    <span className="block px-3 py-1.5 text-sm font-medium text-slate-800">{formatCurrency(Number(schedule.amount) || 0)}</span>
                                                ) : (
                                                    <>
                                                        <span className="absolute left-6 top-1.5 text-slate-400 text-sm">$</span>
                                                        <input
                                                            type="number"
                                                            value={schedule.amount}
                                                            onChange={e => updatePaymentSchedule(index, "amount", e.target.value)}
                                                            onBlur={handleAmountBlur}
                                                            className="w-full bg-transparent focus:outline-none focus:bg-white focus:ring-1 ring-slate-200 rounded px-3 py-1.5 pl-5 transition-all text-sm font-medium text-slate-800"
                                                        />
                                                    </>
                                                )}
                                            </div>
                                            <div className="w-40 px-4 text-right">
                                                <input
                                                    type="date"
                                                    value={schedule.dueDate ? new Date(schedule.dueDate).toISOString().split('T')[0] : ''}
                                                    onChange={e => updatePaymentSchedule(index, "dueDate", e.target.value ? new Date(e.target.value).toISOString() : null)}
                                                    disabled={isPaid}
                                                    className="w-full bg-transparent focus:outline-none focus:bg-white focus:ring-1 ring-slate-200 rounded px-2 py-1.5 text-right transition-all text-sm font-medium text-slate-500 disabled:cursor-default"
                                                />
                                            </div>
                                            <div className="w-32 px-4 text-right">
                                                {isPaid ? (
                                                    <div className="flex flex-col items-end gap-0.5">
                                                        <span className="inline-flex items-center gap-1 text-[11px] font-bold uppercase text-green-700 bg-green-100 px-2 py-0.5 rounded-full">
                                                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
                                                            Paid
                                                        </span>
                                                        {paidOn && (
                                                            <span className="text-[10px] text-slate-400">{formatMoneyDate(paidOn, {})}</span>
                                                        )}
                                                        <button
                                                            onClick={async () => {
                                                                if (!schedule.id) return;
                                                                setIsSendingEstReceipt(schedule.id);
                                                                try {
                                                                    const result = await sendEstimatePaymentReceipt(schedule.id);
                                                                    if (result.success) {
                                                                        toast.success("Receipt sent");
                                                                        router.refresh();
                                                                    } else {
                                                                        toast.error(result.error || "Failed to send receipt");
                                                                    }
                                                                } catch (e: any) {
                                                                    toast.error(e?.message || "Failed to send receipt");
                                                                } finally {
                                                                    setIsSendingEstReceipt(null);
                                                                }
                                                            }}
                                                            disabled={isSendingEstReceipt === schedule.id}
                                                            title={schedule.receiptSentAt ? `Last sent ${new Date(schedule.receiptSentAt).toLocaleString()}` : undefined}
                                                            className="mt-1 text-[10px] text-indigo-600 hover:text-indigo-700 underline underline-offset-2 disabled:opacity-50"
                                                        >
                                                            {isSendingEstReceipt === schedule.id
                                                                ? "Sending..."
                                                                : schedule.receiptSentAt ? "Resend Receipt" : "Send Receipt"}
                                                        </button>
                                                        <button
                                                            onClick={() => setUndoPaymentTarget(schedule)}
                                                            className="text-[10px] text-slate-400 hover:text-red-600 underline underline-offset-2"
                                                        >
                                                            Undo
                                                        </button>
                                                    </div>
                                                ) : isSavedSchedule ? (
                                                    <button
                                                        onClick={() => setRecordingEstPayment({ id: schedule.id, name: schedule.name || "Milestone", amount: Number(schedule.amount) || 0 })}
                                                        className="hui-btn hui-btn-primary py-1.5 px-3 text-xs flex items-center gap-1.5"
                                                    >
                                                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                                        </svg>
                                                        Record Payment
                                                    </button>
                                                ) : (
                                                    <span className="text-[11px] font-medium text-slate-400 uppercase tracking-wide">Pending</span>
                                                )}
                                            </div>
                                            <div className="w-10 pt-0.5 flex justify-end">
                                                {!isPaid && (
                                                    <button onClick={() => removePaymentSchedule(index)} className="text-slate-300 hover:text-red-500 hover:bg-red-50 rounded p-1.5 transition opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto">
                                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                        );
                                    })}
                                </div>
                                {/* Schedule total validation */}
                                {(() => {
                                    const scheduleSum = rm(paymentSchedules.reduce((sum, s) => sum + (parseFloat(s.amount) || 0), 0));
                                    const diff = rm(total - scheduleSum);
                                    const balanced = Math.abs(diff) < 0.01;
                                    return (
                                        <div className={`flex items-center justify-between px-8 py-3 border-t ${balanced ? 'bg-green-50/50 border-green-100' : 'bg-amber-50/50 border-amber-200'}`}>
                                            <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Schedule Total</span>
                                            <div className="flex items-center gap-2.5">
                                                <span className={`text-sm font-bold ${balanced ? 'text-green-700' : 'text-amber-700'}`}>
                                                    {formatCurrency(scheduleSum)}
                                                </span>
                                                <span className="text-xs text-slate-400">of</span>
                                                <span className="text-sm font-medium text-slate-600">{formatCurrency(total)}</span>
                                                {balanced ? (
                                                    <svg className="w-4 h-4 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                                                    </svg>
                                                ) : (
                                                    <span className={`text-xs font-semibold px-1.5 py-0.5 rounded ${diff > 0 ? 'text-amber-700 bg-amber-100' : 'text-red-700 bg-red-100'}`}>
                                                        {diff > 0 ? `${formatCurrency(diff)} under` : `${formatCurrency(Math.abs(diff))} over`}
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })()}
                            </div>
                        )}

                        {/* Footer Totals */}
                            <div className="bg-slate-50 p-10 flex justify-between items-start border-t border-slate-200 gap-8">
                                <div className="flex-1 max-w-lg">
                                    {/* Stripe Fee Pass-Through Cost Savings Banner */}
                                    {viewMode === "internal" && (
                                        <div className="border rounded-xl p-4 transition-all duration-200 shadow-sm bg-white border-slate-200">
                                            <div className="flex items-start gap-3">
                                                <div className={`p-2 rounded-lg flex-shrink-0 ${settings?.passProcessingFee ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50/75 text-amber-600'}`}>
                                                    {settings?.passProcessingFee ? (
                                                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                                            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                                                        </svg>
                                                    ) : (
                                                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                                            <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                                        </svg>
                                                    )}
                                                </div>
                                                <div className="flex-1 min-w-0">
                                                    <div className="flex items-center gap-2">
                                                        <h5 className="font-bold text-slate-800 text-xs tracking-tight">
                                                            {settings?.passProcessingFee ? "Stripe Fee Pass-Through Active" : "Stripe Fees Absorbed by Contractor"}
                                                        </h5>
                                                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${settings?.passProcessingFee ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>
                                                            {settings?.passProcessingFee ? "Saving Money" : "Cost Overhead"}
                                                        </span>
                                                    </div>
                                                    <p className="text-[11px] text-slate-500 mt-1 leading-relaxed">
                                                        {settings?.passProcessingFee ? (
                                                            <>
                                                                Client covers the Stripe card transaction processing fee ({settings?.cardProcessingRate || 2.9}% + ${Number(settings?.cardProcessingFlat || 0.30).toFixed(2)}) at checkout. 
                                                                This preserves your margins, saving you approximately <span className="font-bold text-emerald-600">{formatCurrency(subtotal * (Number(settings?.cardProcessingRate || 2.9) / 100) + Number(settings?.cardProcessingFlat || 0.30))}</span> on this document.
                                                            </>
                                                        ) : (
                                                            <>
                                                                You currently absorb the online transaction processing fee ({settings?.cardProcessingRate || 2.9}% + ${Number(settings?.cardProcessingFlat || 0.30).toFixed(2)}). 
                                                                If the client pays online, it will cost you roughly <span className="font-bold text-amber-600">{formatCurrency(subtotal * (Number(settings?.cardProcessingRate || 2.9) / 100) + Number(settings?.cardProcessingFlat || 0.30))}</span>. 
                                                                To pass card fees to the client and save this cost, toggle fee pass-through in <a href="/settings/payment-methods" className="text-indigo-600 hover:text-indigo-800 underline font-medium transition">Settings</a>.
                                                            </>
                                                        )}
                                                    </p>
                                                </div>
                                            </div>
                                        </div>
                                    )}
                                </div>
                                <div className="w-80 space-y-4 text-sm flex-shrink-0">
                                    <div className="flex justify-between text-slate-500 font-medium">
                                        <span>Subtotal</span>
                                        <span className="text-slate-800">{formatCurrency(subtotal)}</span>
                                    </div>
                                    {!taxExempt && (
                                        <div className="flex justify-between text-slate-500 font-medium">
                                            <span>{taxName}</span>
                                            <span className="text-slate-800">{formatCurrency(tax)}</span>
                                        </div>
                                    )}
                                    {viewMode === "internal" && salesTaxes.length > 0 && (
                                        <div className="flex items-center gap-2 text-xs text-slate-500">
                                            <select
                                                value={taxExempt ? "__exempt__" : (selectedTaxName || "")}
                                                onChange={(e) => {
                                                    if (e.target.value === "__exempt__") {
                                                        setTaxExempt(true);
                                                        setSelectedTaxName(null);
                                                    } else {
                                                        setTaxExempt(false);
                                                        setSelectedTaxName(e.target.value);
                                                    }
                                                }}
                                                className="hui-input text-xs py-1 pl-2 pr-6 rounded"
                                            >
                                                {taxOptions.map(t => (
                                                    <option key={t.name} value={t.name}>
                                                        {t.name} ({Number(parseFloat(String(t.rate)).toFixed(4))}%){("orphaned" in t && t.orphaned) ? " — not in settings" : ""}
                                                    </option>
                                                ))}
                                                <option value="__exempt__">Tax Exempt</option>
                                            </select>
                                        </div>
                                    )}
                                    {viewMode === "internal" && salesTaxes.length === 0 && (
                                        <div className="flex items-center gap-2 text-xs text-slate-500">
                                            <input
                                                type="checkbox"
                                                id="taxExempt"
                                                checked={taxExempt}
                                                onChange={(e) => setTaxExempt(e.target.checked)}
                                                className="accent-hui-primary"
                                            />
                                            <label htmlFor="taxExempt" className="cursor-pointer select-none">
                                                Tax exempt (subcontractor / resale)
                                            </label>
                                        </div>
                                    )}
                                    {viewMode === "internal" && showTaxCertWarning && (
                                        <div className="bg-amber-50 border border-amber-300 rounded-lg p-3">
                                            <div className="flex items-start gap-2">
                                                <svg className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M5.07 19h13.86c1.54 0 2.5-1.67 1.73-3L13.73 4c-.77-1.33-2.69-1.33-3.46 0L3.34 16c-.77 1.33.19 3 1.73 3z" /></svg>
                                                <div className="text-xs">
                                                    <p className="font-bold text-amber-800">
                                                        {taxCertStatus === "expired"
                                                            ? `Exemption certificate expired${context.clientTaxExemptCertExpiresAt ? ` ${formatCertExpiry(context.clientTaxExemptCertExpiresAt)}` : ""}`
                                                            : "No exemption certificate on file"}
                                                    </p>
                                                    <p className="text-amber-700 mt-0.5">WA DOR requires a reseller permit or exemption certificate on file for every tax-exempt sale. Signing is not blocked.</p>
                                                    <a href={taxCertFixHref} className="inline-block mt-1 font-semibold text-amber-800 underline hover:text-amber-900">Add it on the client record →</a>
                                                </div>
                                            </div>
                                        </div>
                                    )}
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

                        {/* Project Overview / Vision Section */}
                        <div className="mt-8 mx-2">
                            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                                <button
                                    onClick={() => setShowOverview(!showOverview)}
                                    className="w-full flex items-center justify-between px-6 py-4 hover:bg-slate-50 transition"
                                >
                                    <div className="flex items-center gap-2">
                                        <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" /></svg>
                                        <span className="text-sm font-semibold text-slate-800">Project Overview</span>
                                        {overviewEnabled && <span className="text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full font-medium">On</span>}
                                    </div>
                                    <svg className={`w-4 h-4 text-slate-400 transition-transform ${showOverview ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                                </button>
                                {showOverview && (
                                    <div className="px-6 pb-5 border-t border-slate-100 space-y-3">
                                        <label className="flex items-start gap-2 mt-3 cursor-pointer">
                                            <input type="checkbox" checked={overviewEnabled} onChange={e => setOverviewEnabled(e.target.checked)} className="mt-0.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
                                            <span className="text-sm text-slate-600">Include a Project Overview page (shown after the header/client info, before pricing, with a page break so the line items begin on the next page).</span>
                                        </label>
                                        <div>
                                            <label className="text-xs font-medium text-slate-500 mb-1 block">Page title</label>
                                            <input value={overviewTitle} onChange={e => setOverviewTitle(e.target.value)} placeholder="Project Overview" className="hui-input w-full text-sm" />
                                        </div>
                                        {overviewTemplates.length > 0 && (
                                            <select
                                                className="hui-input w-full text-sm"
                                                value=""
                                                onChange={e => { const t = overviewTemplates.find(t => t.id === e.target.value); if (t) setOverviewBody(t.body); }}
                                            >
                                                <option value="" disabled>Load a saved overview template...</option>
                                                {overviewTemplates.map(t => <option key={t.id} value={t.id}>{t.name}{t.isDefault ? " (Default)" : ""}</option>)}
                                            </select>
                                        )}
                                        <RichTextEditor
                                            value={overviewBody}
                                            onChange={setOverviewBody}
                                            placeholder="Describe the overall project vision, the major areas of work, and how the scopes fit together. No pricing here."
                                        />
                                        <div className="flex justify-end">
                                            <button type="button" onClick={() => handleSaveDocTemplate("overview", overviewBody)} disabled={isSavingOverviewTpl} className="text-xs font-medium text-indigo-600 hover:text-indigo-800 disabled:opacity-50">
                                                {isSavingOverviewTpl ? "Saving…" : "Save as template"}
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Estimate Notes & Assumptions Section */}
                        <div className="mt-8 mx-2">
                            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                                <button
                                    onClick={() => setShowNotes(!showNotes)}
                                    className="w-full flex items-center justify-between px-6 py-4 hover:bg-slate-50 transition"
                                >
                                    <div className="flex items-center gap-2">
                                        <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" /></svg>
                                        <span className="text-sm font-semibold text-slate-800">Notes &amp; Assumptions</span>
                                        {notesEnabled && <span className="text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full font-medium">On</span>}
                                    </div>
                                    <svg className={`w-4 h-4 text-slate-400 transition-transform ${showNotes ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                                </button>
                                {showNotes && (
                                    <div className="px-6 pb-5 border-t border-slate-100 space-y-3">
                                        <label className="flex items-start gap-2 mt-3 cursor-pointer">
                                            <input type="checkbox" checked={notesEnabled} onChange={e => setNotesEnabled(e.target.checked)} className="mt-0.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
                                            <span className="text-sm text-slate-600">Include a Notes &amp; Assumptions section for exclusions, allowances, and estimating assumptions.</span>
                                        </label>
                                        <div className="grid grid-cols-2 gap-3">
                                            <div>
                                                <label className="text-xs font-medium text-slate-500 mb-1 block">Section title</label>
                                                <input value={notesTitle} onChange={e => setNotesTitle(e.target.value)} placeholder="Estimate Notes & Assumptions" className="hui-input w-full text-sm" />
                                            </div>
                                            <div>
                                                <label className="text-xs font-medium text-slate-500 mb-1 block">Placement</label>
                                                <select value={notesPlacement} onChange={e => setNotesPlacement(e.target.value === "before" ? "before" : "after")} className="hui-input w-full text-sm">
                                                    <option value="before">Before the line items</option>
                                                    <option value="after">After the line items</option>
                                                </select>
                                            </div>
                                        </div>
                                        {notesTemplates.length > 0 && (
                                            <select
                                                className="hui-input w-full text-sm"
                                                value=""
                                                onChange={e => { const t = notesTemplates.find(t => t.id === e.target.value); if (t) setNotesBody(t.body); }}
                                            >
                                                <option value="" disabled>Load a saved notes template...</option>
                                                {notesTemplates.map(t => <option key={t.id} value={t.id}>{t.name}{t.isDefault ? " (Default)" : ""}</option>)}
                                            </select>
                                        )}
                                        <RichTextEditor
                                            value={notesBody}
                                            onChange={setNotesBody}
                                            placeholder="Exclusions, allowances, and assumptions behind this estimate..."
                                        />
                                        <div className="flex justify-end">
                                            <button type="button" onClick={() => handleSaveDocTemplate("notes", notesBody)} disabled={isSavingNotesTpl} className="text-xs font-medium text-indigo-600 hover:text-indigo-800 disabled:opacity-50">
                                                {isSavingNotesTpl ? "Saving…" : "Save as template"}
                                            </button>
                                        </div>
                                    </div>
                                )}
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
                                        {termsTemplates.length > 0 && (
                                            <select
                                                className="hui-input w-full text-sm mb-2"
                                                value=""
                                                onChange={e => {
                                                    const t = termsTemplates.find(t => t.id === e.target.value);
                                                    if (t) setTermsAndConditions(t.body);
                                                }}
                                            >
                                                <option value="" disabled>Load a template...</option>
                                                {termsTemplates.map(t => (
                                                    <option key={t.id} value={t.id}>{t.name}{t.isDefault ? " (Default)" : ""}</option>
                                                ))}
                                            </select>
                                        )}
                                        <textarea
                                            value={termsAndConditions}
                                            onChange={e => setTermsAndConditions(e.target.value)}
                                            placeholder="Enter your terms and conditions here, or select a template above..."
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
                <div className="w-full lg:w-96 border-t lg:border-t-0 lg:border-l border-slate-200 bg-white flex flex-col overflow-visible lg:overflow-y-auto overflow-x-hidden lg:shrink-0">
                    {/* Sidebar Tabs */}
                    <div className="flex border-b border-slate-200 sticky top-0 bg-white z-10">
                        <button
                            onClick={() => setSidebarTab("overview")}
                            className={`flex-1 px-3 py-2.5 text-sm font-medium transition ${sidebarTab === "overview" ? "text-indigo-600 border-b-2 border-indigo-600" : "text-slate-500 hover:text-slate-700"}`}
                        >Overview</button>
                        <button
                            onClick={() => setSidebarTab("activity")}
                            className={`flex-1 px-3 py-2.5 text-sm font-medium transition ${sidebarTab === "activity" ? "text-indigo-600 border-b-2 border-indigo-600" : "text-slate-500 hover:text-slate-700"}`}
                        >Activity</button>
                        <button
                            onClick={() => setSidebarTab("comments")}
                            className={`flex-1 px-3 py-2.5 text-sm font-medium transition ${sidebarTab === "comments" ? "text-indigo-600 border-b-2 border-indigo-600" : "text-slate-500 hover:text-slate-700"}`}
                        >Comments</button>
                        <button
                            onClick={() => setSidebarTab("history")}
                            className={`flex-1 px-3 py-2.5 text-sm font-medium transition ${sidebarTab === "history" ? "text-indigo-600 border-b-2 border-indigo-600" : "text-slate-500 hover:text-slate-700"}`}
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

                    {sidebarTab === "activity" && (() => {
                        // Append-only feed from the server (every send/resend, view, signature,
                        // invoice lifecycle, settled payments). Falls back to the legacy
                        // single-timestamp rendering only if the prop is missing.
                        const events: ActivityEvent[] = activityEvents ?? [
                            { id: "created", ts: initialEstimate.createdAt, kind: "created", title: "Estimate created" },
                            ...(initialEstimate.sentAt ? [{ id: "sent", ts: initialEstimate.sentAt, kind: "sent" as const, title: "Sent to client" }] : []),
                            ...(initialEstimate.viewedAt ? [{ id: "viewed", ts: initialEstimate.viewedAt, kind: "viewed" as const, title: "Viewed by client" }] : []),
                            ...(initialEstimate.approvedAt ? [{ id: "signed", ts: initialEstimate.approvedAt, kind: "signed" as const, title: `Approved${initialEstimate.approvedBy ? ` by ${initialEstimate.approvedBy}` : ""}` }] : []),
                        ];
                        const iconFor = (kind: ActivityEvent["kind"]) => {
                            switch (kind) {
                                case "created": return { bg: "bg-slate-200", fg: "text-slate-500", path: "M12 6v6m0 0v6m0-6h6m-6 0H6" };
                                case "sent": return { bg: "bg-amber-100", fg: "text-amber-600", path: "M12 19l9 2-9-18-9 18 9-2zm0 0v-8" };
                                case "viewed": return { bg: "bg-blue-100", fg: "text-blue-600", path: "M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7zM15 12a3 3 0 11-6 0 3 3 0 016 0z" };
                                case "signed": return { bg: "bg-green-100", fg: "text-green-600", path: "M5 13l4 4L19 7" };
                                case "invoice": return { bg: "bg-indigo-100", fg: "text-indigo-600", path: "M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" };
                                case "payment": return { bg: "bg-emerald-100", fg: "text-emerald-600", path: "M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" };
                                default: return { bg: "bg-slate-100", fg: "text-slate-500", path: "M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" };
                            }
                        };
                        return (
                            <div className="p-5">
                                <div className="relative">
                                    <div className="absolute left-[11px] top-6 bottom-3 w-0.5 bg-slate-200"></div>
                                    <div className="space-y-4">
                                        {events.map(ev => {
                                            const icon = iconFor(ev.kind);
                                            return (
                                                <div key={ev.id} className="flex items-start gap-3 relative">
                                                    <div className={`w-6 h-6 rounded-full ${icon.bg} flex items-center justify-center shrink-0 z-10`}>
                                                        <svg className={`w-3 h-3 ${icon.fg}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={icon.path} /></svg>
                                                    </div>
                                                    <div className="min-w-0">
                                                        <p className="text-sm font-medium text-slate-800">{ev.title}</p>
                                                        {ev.detail && <p className="text-xs text-slate-500 truncate" title={ev.detail}>{ev.detail}</p>}
                                                        <p className="text-xs text-slate-400">
                                                            {(() => {
                                                                const evDate = new Date(ev.ts);
                                                                const dateStr = formatMoneyDate(evDate, { month: 'short', day: 'numeric', year: 'numeric' });
                                                                // Calendar-day values (e.g. paidAt-less settled payments) carry no real
                                                                // time-of-day — showing "12:00 AM" would be misleading, so only append
                                                                // a time for values that are genuine instants.
                                                                if (isDateOnly(evDate)) return dateStr;
                                                                return `${dateStr}, ${evDate.toLocaleString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
                                                            })()}
                                                        </p>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                        {events.length <= 1 && (
                                            <div className="mt-4 text-center py-6">
                                                <svg className="w-10 h-10 text-slate-300 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                                                <p className="text-sm text-slate-500">No activity yet</p>
                                                <p className="text-xs text-slate-400 mt-1">Send the estimate to start tracking</p>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        );
                    })()}

                    {sidebarTab === "comments" && (
                        <div className="flex-1 flex flex-col min-h-0">
                            <DocumentComments
                                documentType="estimate"
                                documentId={initialEstimate.id}
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

            {/* Import from ChatGPT Modal */}
            {showImportModal && (
                <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
                    <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full overflow-hidden border border-purple-200">
                        <div className="px-6 py-4 border-b border-purple-100 bg-gradient-to-r from-purple-50 to-indigo-50 flex justify-between items-center">
                            <div className="flex items-center gap-3">
                                <div className="w-8 h-8 rounded-lg bg-purple-100 flex items-center justify-center">
                                    <svg className="w-4 h-4 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10" /></svg>
                                </div>
                                <div>
                                    <h2 className="text-lg font-bold text-hui-textMain">Import from ChatGPT</h2>
                                    <p className="text-xs text-purple-600">Paste JSON • builds phases + line items + milestones</p>
                                </div>
                            </div>
                            <button onClick={() => setShowImportModal(false)} className="text-hui-textMuted hover:text-hui-textMain transition">
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                            </button>
                        </div>
                        <div className="p-6 space-y-4">
                            <div className="bg-slate-50 rounded-lg p-3 text-xs text-slate-600 space-y-1.5">
                                <div className="font-semibold text-slate-700">How to use:</div>
                                <div>1. Click <strong>Copy ChatGPT prompt</strong> below and paste it into ChatGPT, then describe your project.</div>
                                <div>2. Copy ChatGPT&apos;s JSON reply and paste it into the box below.</div>
                                <div>3. Click <strong>Import</strong> — phases become collapsible groups with line items beneath them.</div>
                                <button
                                    type="button"
                                    onClick={async () => {
                                        try {
                                            await navigator.clipboard.writeText(CHATGPT_ESTIMATE_PROMPT);
                                            toast.success("Prompt copied — paste it into ChatGPT");
                                        } catch {
                                            toast.error("Couldn't copy — select the prompt manually");
                                        }
                                    }}
                                    className="mt-1 inline-flex items-center gap-1.5 text-purple-700 hover:text-purple-900 font-medium"
                                >
                                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                                    Copy ChatGPT prompt
                                </button>
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-hui-textMain mb-2">Paste ChatGPT&apos;s JSON</label>
                                <textarea
                                    value={importJson}
                                    onChange={e => setImportJson(e.target.value)}
                                    placeholder={'{\n  "phases": [ { "phaseName": "Demolition", "items": [ { "name": "...", "costType": "Labor", "quantity": 1, "unit": "job", "unitCost": 1800 } ] } ],\n  "paymentMilestones": [ { "name": "Deposit", "percentage": 25 } ]\n}'}
                                    className="hui-input w-full h-40 resize-none font-mono text-xs"
                                    disabled={isImporting}
                                />
                            </div>
                            {items.length > 0 && (
                                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800">
                                    <strong>Note:</strong> Imported items will be appended to your existing {items.length} item(s).
                                </div>
                            )}
                        </div>
                        <div className="px-6 py-4 border-t border-hui-border flex justify-end gap-3 bg-slate-50">
                            <button
                                type="button"
                                onClick={() => setShowImportModal(false)}
                                disabled={isImporting}
                                className="hui-btn hui-btn-secondary"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleImportEstimate}
                                disabled={isImporting || !importJson.trim()}
                                className="hui-btn bg-gradient-to-r from-purple-600 to-indigo-600 text-white hover:from-purple-700 hover:to-indigo-700 disabled:opacity-50 flex items-center gap-2"
                            >
                                {isImporting ? (
                                    <>
                                        <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                                        Importing...
                                    </>
                                ) : (
                                    <>
                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19l3 3m0 0l3-3m-3 3V10M5 8a4 4 0 014-4h6a4 4 0 014 4" /></svg>
                                        Import
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
                    balanceDue={dynamicBalanceDue}
                    onClose={() => setShowPaymentModal(false)}
                    onSaved={(result) => {
                        setPaymentSchedules(prev => [...prev, result.schedule]);
                        setStatus(result.newStatus);
                        router.refresh();
                    }}
                />
            )}

            {recordingEstPayment && (
                <RecordPaymentModal
                    milestoneName={recordingEstPayment.name}
                    amount={recordingEstPayment.amount}
                    onClose={() => setRecordingEstPayment(null)}
                    onSubmit={async (input) => {
                        await handleSave({ silent: true, skipRefresh: true });
                        const result = await recordEstimatePayment(recordingEstPayment.id, initialEstimate.id, {
                            ...input,
                            amount: recordingEstPayment.amount,
                        });
                        if (result.success) {
                            setPaymentSchedules(prev => prev.map(s =>
                                s.id === recordingEstPayment.id
                                    ? { ...s, status: "Paid", amount: String(recordingEstPayment.amount), paymentMethod: input.method, referenceNumber: input.referenceNumber || null, paymentDate: input.paymentDate, paidAt: new Date().toISOString(), notes: input.notes || null }
                                    : s
                            ));
                            router.refresh();
                        }
                        return { success: result.success, error: (result as any).error };
                    }}
                />
            )}

            {undoPaymentTarget && (() => {
                const paidSchedules = paymentSchedules.filter(s => s.status === "Paid");
                const paidSum = paidSchedules.reduce((sum: number, s: any) => sum + (parseFloat(s.amount) || 0), 0);
                const currentBalance = Math.max(0, total - paidSum);
                return (
                    <UndoPaymentModal
                        milestoneName={undoPaymentTarget.name || "Payment"}
                        amount={Number(undoPaymentTarget.amount) || 0}
                        paymentMethod={undoPaymentTarget.paymentMethod || null}
                        referenceNumber={undoPaymentTarget.referenceNumber || null}
                        paidAt={undoPaymentTarget.paidAt || null}
                        paymentDate={undoPaymentTarget.paymentDate || null}
                        hasStripeIntent={!!undoPaymentTarget.stripePaymentIntentId}
                        hasQbPayment={undoPaymentTarget.paymentMethod === "quickbooks"}
                        currentBalance={currentBalance}
                        estimateTotal={total}
                        currentStatus={status}
                        otherPaidCount={paidSchedules.filter((s: any) => s.id !== undoPaymentTarget.id).length}
                        statusBeforePayment={initialEstimate.statusBeforePayment || null}
                        onClose={() => setUndoPaymentTarget(null)}
                        onConfirm={async () => {
                            try {
                                const res = await unrecordEstimatePayment(undoPaymentTarget.id, initialEstimate.id);
                                if (!res?.success) { toast.error("Nothing to unrecord"); return; }
                                setPaymentSchedules(prev => prev.map(s =>
                                    s.id === undoPaymentTarget.id
                                        ? { ...s, status: "Pending", paymentMethod: null, referenceNumber: null, paymentDate: null, paidAt: null, notes: null }
                                        : s
                                ));
                                toast("Payment unrecorded");
                                setUndoPaymentTarget(null);
                                router.refresh();
                            } catch (e: any) {
                                toast.error(e?.message || "Failed to unrecord payment");
                            }
                        }}
                    />
                );
            })()}

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
                            ) : projectPOs.map(po => {
                                const currentItem = items.find((i: any) => i.id === poLinkItemId);
                                const alreadyLinked = (currentItem?.purchaseOrderLinks ?? []).some((l: any) => l.purchaseOrder.id === po.id);
                                return (
                                    <button
                                        key={po.id}
                                        disabled={alreadyLinked}
                                        onClick={() => handleSelectPO(poLinkItemId, po)}
                                        className="w-full text-left px-3 py-2 text-sm hover:bg-indigo-50 transition flex justify-between items-center disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                                    >
                                        <span className="font-medium flex items-center gap-1.5">
                                            {alreadyLinked && (
                                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-green-600 flex-shrink-0"><path d="M20 6 9 17l-5-5" /></svg>
                                            )}
                                            {po.code} — {po.vendor?.name}
                                        </span>
                                        <span className="text-slate-500">{formatCurrency(Number(po.totalAmount))}</span>
                                    </button>
                                );
                            })}
                        </div>
                        <div className="px-6 py-4 border-t border-slate-100 bg-slate-50 flex justify-end">
                            <button
                                onClick={() => setPOLinkItemId(null)}
                                className="hui-btn hui-btn-primary"
                            >
                                Done
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

