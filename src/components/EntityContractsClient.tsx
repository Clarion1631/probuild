"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
    createContractFromTemplate, createContractBlank, sendContractToClient,
    deleteContract, getContractSigningHistory, updateContract, signContractAsContractor,
    getResolvedMergePreview, getContractSendDefaults, countersignContractAsCompany,
} from "@/lib/actions";
import { toast } from "sonner";
import DOMPurify from "dompurify";
import { ContractWysiwygEditor } from "@/components/ContractWysiwygEditor";
import { CONTRACT_PROSE_CLASSES } from "@/lib/contract-styles";
import DocumentSignModal from "@/components/DocumentSignModal";

interface Template { id: string; name: string; type: string; }
interface SigningRecord {
    id: string; signedBy: string; signedAt: string | Date;
    periodStart?: string | Date | null; periodEnd?: string | Date | null;
    signatureUrl?: string | null;
}
interface Entity { type: "lead" | "project"; id: string; name: string; clientName: string; }
interface LinkedEntity { type: "lead" | "project"; id: string; name: string; }

const STATUS_COLORS: Record<string, string> = {
    Draft: "bg-gray-100 text-gray-700 border-gray-200",
    Sent: "bg-blue-100 text-blue-700 border-blue-200",
    Viewed: "bg-yellow-100 text-yellow-700 border-yellow-200",
    Signed: "bg-green-100 text-green-700 border-green-200",
    Finalized: "bg-emerald-100 text-emerald-700 border-emerald-200",
    Declined: "bg-red-100 text-red-700 border-red-200",
};

const TYPE_LABEL: Record<string, string> = {
    contract: "Contracts", lien_release: "Lien Releases", change_order: "Change Orders",
    draw_request: "Draw Requests", warranty: "Warranties", punch_list: "Punch Lists",
    addendum: "Addenda", disclaimer: "Disclaimers", terms: "Terms & Conditions",
};

export default function EntityContractsClient({
    entity, contracts: initialContracts, templates, linkedEntity, autoCreate,
}: {
    entity: Entity;
    contracts: any[];
    templates: Template[];
    linkedEntity?: LinkedEntity | null;
    autoCreate?: boolean;
}) {
    const router = useRouter();
    const context = { type: entity.type, id: entity.id };

    // ─── CREATE MENU ───
    const [showCreateMenu, setShowCreateMenu] = useState(false);

    // ─── TEMPLATE MODAL ───
    const [showTemplateModal, setShowTemplateModal] = useState(false);
    const [selectedTemplate, setSelectedTemplate] = useState("");
    const [templateSearch, setTemplateSearch] = useState("");
    const [isRecurring, setIsRecurring] = useState(false);
    const [recurringDays, setRecurringDays] = useState(30);
    const [isCreating, setIsCreating] = useState(false);

    // ─── AI DRAFT ───
    const [isDrafting, setIsDrafting] = useState(false);
    const [showDraftPanel, setShowDraftPanel] = useState(false);
    const [draftedHtml, setDraftedHtml] = useState<string | null>(null);

    // ─── BLANK EDITOR ───
    const [creatingBlank, setCreatingBlank] = useState(false);
    const [blankTitle, setBlankTitle] = useState("");
    const [blankBody, setBlankBody] = useState("");

    // ─── EDIT EDITOR ───
    const [editingContract, setEditingContract] = useState<any>(null);
    const [editTitle, setEditTitle] = useState("");
    const [editBody, setEditBody] = useState("");
    const [saving, setSaving] = useState(false);

    // ─── HISTORY ───
    const [historyModal, setHistoryModal] = useState<string | null>(null);
    const [signingHistory, setSigningHistory] = useState<SigningRecord[]>([]);
    const [loadingHistory, setLoadingHistory] = useState(false);

    // ─── CONTRACTOR SIGNING ───
    const [contractorSignModal, setContractorSignModal] = useState<any>(null);
    const [signingAsContractor, setSigningAsContractor] = useState(false);
    const [showContractorSignPrompt, setShowContractorSignPrompt] = useState(false);
    const [pendingSendContractId, setPendingSendContractId] = useState<string | null>(null);

    // ─── COMPANY COUNTERSIGN ───
    const [companyCountersignModal, setCompanyCountersignModal] = useState<any>(null);
    const [signingAsCompany, setSigningAsCompany] = useState(false);
    const [editRequiresCountersign, setEditRequiresCountersign] = useState(false);

    // ─── SEND DIALOG (editable CC) ───
    const [sendDialog, setSendDialog] = useState<{ contractId: string; toEmail: string; cc: string } | null>(null);
    const [sendingDialog, setSendingDialog] = useState(false);

    // ─── PREVIEW MODE ───
    const [isPreview, setIsPreview] = useState(false);
    const [previewHtml, setPreviewHtml] = useState("");
    const [loadingPreview, setLoadingPreview] = useState(false);

    // Template helpers
    const filteredTemplates = templates.filter(t =>
        t.name.toLowerCase().includes(templateSearch.toLowerCase())
    );
    const templatesByType = templates.reduce<Record<string, Template[]>>((acc, t) => {
        (acc[t.type] ??= []).push(t);
        return acc;
    }, {});

    useEffect(() => {
        if (autoCreate) setShowCreateMenu(true);
    }, [autoCreate]);

    // ─── HANDLERS ───

    const handleTemplateChange = (templateId: string) => {
        setSelectedTemplate(templateId);
        const t = templates.find(t => t.id === templateId);
        if (t?.type === "lien_release") { setIsRecurring(true); setRecurringDays(30); }
    };

    const handleCreateFromTemplate = async () => {
        if (!selectedTemplate) return;
        setIsCreating(true);
        try {
            const newContract = await createContractFromTemplate(selectedTemplate, context, undefined, isRecurring ? recurringDays : undefined);
            toast.success("Contract created!");
            setShowTemplateModal(false); setSelectedTemplate(""); setIsRecurring(false);
            openEditor(newContract);
            router.refresh();
        } catch (e: any) { toast.error(e.message || "Failed to create"); }
        finally { setIsCreating(false); }
    };

    const handleSaveBlank = async () => {
        if (!blankTitle.trim()) { toast.error("Please enter a contract title"); return; }
        setSaving(true);
        try {
            const newContract = await createContractBlank(context, blankTitle, blankBody);
            toast.success("Contract created!");
            setCreatingBlank(false);
            openEditor(newContract);
            router.refresh();
        } catch (e: any) { toast.error(e.message || "Failed to create"); }
        finally { setSaving(false); }
    };

    const openEditor = (contract: any) => {
        setEditingContract(contract);
        setEditTitle(contract.title);
        setEditBody(contract.body);
        setEditRequiresCountersign(!!contract.requiresCountersign);
    };

    const handleSaveEdit = async () => {
        if (!editingContract) return;
        setSaving(true);
        try {
            const updated = await updateContract(editingContract.id, { title: editTitle, body: editBody, requiresCountersign: editRequiresCountersign });
            toast.success("Contract updated!");
            setEditingContract(updated);
            router.refresh();
        } catch (e: any) { toast.error(e.message || "Failed to update contract"); }
        finally { setSaving(false); }
    };

    async function handleDraftContract() {
        setIsDrafting(true);
        try {
            const body = entity.type === "project"
                ? { projectId: entity.id }
                : { leadId: entity.id };
            const res = await fetch("/api/ai/draft-contract", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "Draft failed");
            setDraftedHtml(data.contractHtml);
            setShowDraftPanel(true);
        } catch (e: any) { toast.error(e.message || "Contract drafting failed"); }
        finally { setIsDrafting(false); }
    }

    const contractHasContractorBlock = (body: string) =>
        body.includes("{{CONTRACTOR_SIGNATURE_BLOCK}}") || body.includes('data-merge-field="CONTRACTOR_SIGNATURE_BLOCK"');

    const handleSend = async (contractId: string) => {
        const contract = (editingContract?.id === contractId ? editingContract : null)
            ?? initialContracts.find((c: any) => c.id === contractId);
        if (contract && contractHasContractorBlock(contract.body || "") && !contract.contractorSignedBy) {
            setPendingSendContractId(contractId);
            setShowContractorSignPrompt(true);
            return;
        }
        await openSendDialog(contractId);
    };

    const openSendDialog = async (contractId: string) => {
        try {
            const defaults = await getContractSendDefaults(contractId);
            setSendDialog({ contractId, toEmail: defaults.toEmail || "", cc: defaults.autoCc.join(", ") });
        } catch (e: any) {
            toast.error(e.message || "Couldn't load recipients");
        }
    };

    const confirmSend = async () => {
        if (!sendDialog) return;
        const { contractId, cc } = sendDialog;
        const ccArray = cc.split(/[,;]+/).map(s => s.trim()).filter(Boolean);
        setSendingDialog(true);
        try {
            const result = await sendContractToClient(contractId, ccArray);
            toast.success(
                `Contract sent to ${result.clientName || entity.clientName} at ${result.sentTo}`,
                { description: entity.name }
            );
            if (editingContract && editingContract.id === contractId) {
                setEditingContract({ ...editingContract, status: "Sent" });
            }
            setSendDialog(null);
            router.refresh();
        } catch (e: any) { toast.error(e.message || "Failed to send"); }
        finally { setSendingDialog(false); }
    };

    const handleCompanyCountersign = async (dataUrl: string, name: string) => {
        if (!companyCountersignModal) return;
        setSigningAsCompany(true);
        try {
            await countersignContractAsCompany(companyCountersignModal.id, name, dataUrl);
            toast.success("Countersigned — contract fully executed!");
            setCompanyCountersignModal(null);
            router.refresh();
        } catch (e: any) { toast.error(e.message || "Failed to countersign"); }
        finally { setSigningAsCompany(false); }
    };

    const handlePreviewToggle = async () => {
        if (isPreview) {
            setIsPreview(false);
            return;
        }
        setLoadingPreview(true);
        try {
            const projectId = entity.type === "project" ? entity.id : null;
            const leadId = entity.type === "lead" ? entity.id : null;
            const mergeData = await getResolvedMergePreview(projectId, leadId);
            let html = editBody;
            const highlight = (key: string) => {
                if (key in mergeData && mergeData[key]) {
                    const escaped = mergeData[key].replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
                    return `<span style="background:#fef3c7;border-bottom:2px solid #f59e0b;padding:0 2px;">${escaped}</span>`;
                }
                if (key in mergeData) {
                    return `<span style="background:#fee2e2;border-bottom:2px solid #ef4444;padding:0 2px;font-style:italic;color:#991b1b;">empty</span>`;
                }
                return null;
            };
            // Process TipTap span nodes first (they may contain raw {{key}} inside)
            html = html.replace(/<span[^>]*data-merge-field="(\w+)"[^>]*>[\s\S]*?<\/span>/g, (_match, key) => {
                return highlight(key) ?? _match;
            });
            // Then handle any remaining raw placeholders
            html = html.replace(/\{\{(\w+)\}\}/g, (match, key) => {
                return highlight(key) ?? match;
            });
            // Highlight the signing fields so the author can see exactly where the customer signs.
            const SIGNING_LABELS: Record<string, string> = {
                SIGNATURE_BLOCK: "✍ Client signs here",
                INITIAL_BLOCK: "Client initials",
                DATE_BLOCK: "Date",
                CONTRACTOR_SIGNATURE_BLOCK: "✍ Contractor signs here",
            };
            html = html.replace(/\{\{(SIGNATURE_BLOCK|INITIAL_BLOCK|DATE_BLOCK|CONTRACTOR_SIGNATURE_BLOCK)\}\}/g, (_m, key) =>
                `<span style="display:inline-block;background:#dbeafe;border:1px dashed #3b82f6;border-radius:6px;padding:2px 10px;color:#1d4ed8;font-size:13px;font-weight:600;">${SIGNING_LABELS[key] || key}</span>`);
            setPreviewHtml(html);
            setIsPreview(true);
        } catch (e: any) {
            toast.error("Failed to load preview");
        } finally {
            setLoadingPreview(false);
        }
    };

    const handleDelete = async (contractId: string) => {
        if (!confirm("Delete this contract?")) return;
        try { await deleteContract(contractId); toast.success("Deleted"); router.refresh(); }
        catch { toast.error("Failed to delete"); }
    };

    const handleViewHistory = async (contractId: string) => {
        setHistoryModal(contractId);
        setLoadingHistory(true);
        try {
            const records = await getContractSigningHistory(contractId);
            setSigningHistory(records as unknown as SigningRecord[]);
        } catch { toast.error("Failed to load history"); }
        finally { setLoadingHistory(false); }
    };

    const handleContractorSign = async (dataUrl: string, name: string) => {
        if (!contractorSignModal) return;
        setSigningAsContractor(true);
        try {
            await signContractAsContractor(contractorSignModal.id, name, dataUrl);
            toast.success("Contractor signature saved!");
            setContractorSignModal(null);
            router.refresh();
        } catch (e: any) { toast.error(e.message || "Failed to save signature"); }
        finally { setSigningAsContractor(false); }
    };

    // ═══════════════════════════════════════
    // BLANK CONTRACT EDITOR (full-screen)
    // ═══════════════════════════════════════
    if (creatingBlank) {
        return (
            <div className="fixed inset-0 z-50 font-sans text-slate-900 flex flex-col bg-white">
                <header className="bg-white border-b border-slate-200 px-6 py-3 flex items-center justify-between shrink-0">
                    <div className="flex items-center gap-3">
                        <button onClick={() => setCreatingBlank(false)} className="text-slate-400 hover:text-slate-700 transition p-1">
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                        </button>
                        <div>
                            <input
                                type="text"
                                value={blankTitle}
                                onChange={e => setBlankTitle(e.target.value)}
                                className="text-lg font-bold text-slate-800 bg-transparent border-none outline-none w-96 placeholder:text-slate-300"
                                placeholder="Contract Title"
                                autoFocus
                            />
                            <p className="text-xs text-slate-400">{entity.name} · {entity.clientName}</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-3">
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold border bg-gray-100 text-gray-700 border-gray-200">Draft</span>
                        <button onClick={() => setCreatingBlank(false)} className="px-3 py-1.5 text-sm text-slate-500 hover:text-slate-700 border border-slate-200 rounded-lg transition">Cancel</button>
                        <button onClick={handleSaveBlank} disabled={saving} className="px-4 py-1.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition shadow-sm disabled:opacity-50">
                            {saving ? "Creating..." : "Create Contract"}
                        </button>
                    </div>
                </header>
                <ContractWysiwygEditor value={blankBody} onChange={setBlankBody} />
            </div>
        );
    }

    // ═══════════════════════════════════════
    // EXISTING CONTRACT EDITOR (full-screen)
    // ═══════════════════════════════════════
    if (editingContract) {
        return (
            <div className="fixed inset-0 z-50 font-sans text-slate-900 flex flex-col bg-white">
                <header className="bg-white border-b border-slate-200 px-6 py-3 flex items-center justify-between shrink-0">
                    <div className="flex items-center gap-3">
                        <button onClick={() => setEditingContract(null)} className="text-slate-400 hover:text-slate-700 transition p-1">
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                        </button>
                        <div>
                            <input
                                type="text"
                                value={editTitle}
                                onChange={e => setEditTitle(e.target.value)}
                                className="text-lg font-bold text-slate-800 bg-transparent border-none outline-none w-96 placeholder:text-slate-300"
                                placeholder="Contract Title"
                            />
                            <p className="text-xs text-slate-400">{entity.name} · {entity.clientName}</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-3">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${STATUS_COLORS[editingContract.status] || STATUS_COLORS.Draft}`}>
                            {editingContract.status}
                        </span>
                        {!editingContract.recurringDays && (
                            <button
                                type="button"
                                onClick={() => setEditRequiresCountersign(v => !v)}
                                title="When on, the contract is fully executed only after your company countersigns the client's signature. Save to apply."
                                className={`px-3 py-1.5 text-sm font-medium rounded-lg transition border ${editRequiresCountersign ? "bg-indigo-50 text-indigo-700 border-indigo-300" : "text-slate-500 border-slate-200 hover:bg-slate-50"}`}
                            >
                                {editRequiresCountersign ? "✓ Countersign required" : "Countersign off"}
                            </button>
                        )}
                        <button onClick={handlePreviewToggle} disabled={loadingPreview} className={`px-3 py-1.5 text-sm font-medium rounded-lg transition border ${isPreview ? "bg-amber-50 text-amber-700 border-amber-300" : "text-slate-600 border-slate-200 hover:bg-slate-50"}`}>
                            {loadingPreview ? "Loading..." : isPreview ? "Back to Editor" : "Preview"}
                        </button>
                        {(editingContract.status === "Draft" || editingContract.status === "Sent") && (
                            <button onClick={() => handleSend(editingContract.id)} className="px-4 py-1.5 text-sm font-medium text-white bg-green-600 hover:bg-green-700 rounded-lg transition shadow-sm">
                                {editingContract.status === "Sent" ? "Resend" : "Send"}
                            </button>
                        )}
                        <button onClick={() => { setEditingContract(null); setIsPreview(false); }} className="px-3 py-1.5 text-sm text-slate-500 hover:text-slate-700 border border-slate-200 rounded-lg transition">Cancel</button>
                        <button onClick={handleSaveEdit} disabled={saving || isPreview} className="px-4 py-1.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition shadow-sm disabled:opacity-50">
                            {saving ? "Saving..." : "Save Changes"}
                        </button>
                    </div>
                </header>
                {isPreview ? (
                    <div className="flex-1 overflow-auto bg-slate-50 p-8">
                        <div className="max-w-[816px] mx-auto bg-white shadow-sm rounded-lg p-12">
                            <div className="mb-4 flex items-center gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                                <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                                <span>Preview — merge fields show their resolved values (empty = red); blue dashed chips mark where the customer signs.</span>
                            </div>
                            <div className={CONTRACT_PROSE_CLASSES} dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(previewHtml, { USE_PROFILES: { html: true } }) }} />
                        </div>
                    </div>
                ) : (
                    <ContractWysiwygEditor value={editBody} onChange={setEditBody} />
                )}
            </div>
        );
    }

    // ═══════════════════════════════════════
    // CONTRACT LIST
    // ═══════════════════════════════════════
    return (
        <div className="flex-1 overflow-auto">
            <div className="max-w-4xl mx-auto px-8 py-8">
                {/* Header */}
                <div className="flex items-center justify-between mb-6">
                    <div>
                        <h1 className="text-xl font-bold text-hui-textMain">Contracts &amp; Lien Releases</h1>
                        <p className="text-sm text-hui-textMuted">{entity.name} · {entity.clientName}</p>
                    </div>
                    <div className="flex items-center gap-2">
                        {/* AI Draft */}
                        <button
                            onClick={handleDraftContract}
                            disabled={isDrafting}
                            className="hui-btn bg-gradient-to-r from-purple-50 to-indigo-50 border-purple-200 text-purple-700 hover:from-purple-100 hover:to-indigo-100 text-sm flex items-center gap-1.5 disabled:opacity-50"
                        >
                            ✨ {isDrafting ? "Drafting…" : "AI Draft Contract"}
                        </button>

                        {/* Create Dropdown */}
                        <div className="relative">
                            <button
                                onClick={() => setShowCreateMenu(!showCreateMenu)}
                                className="hui-btn hui-btn-primary flex items-center gap-2"
                            >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                                Create
                                <svg className="w-3 h-3 ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 9l6 6 6-6" /></svg>
                            </button>
                            {showCreateMenu && (
                                <div className="absolute right-0 mt-2 w-56 bg-white border border-slate-200 rounded-xl shadow-xl overflow-hidden z-30">
                                    <button
                                        onClick={() => { setCreatingBlank(true); setShowCreateMenu(false); }}
                                        className="w-full flex items-center gap-3 px-4 py-3 text-sm text-slate-700 hover:bg-slate-50 transition text-left"
                                    >
                                        <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                                        From scratch
                                    </button>
                                    <button
                                        onClick={() => { setShowCreateMenu(false); setShowTemplateModal(true); }}
                                        className="w-full flex items-center gap-3 px-4 py-3 text-sm text-slate-700 hover:bg-slate-50 transition text-left border-t border-slate-100"
                                    >
                                        <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7v8a2 2 0 002 2h6M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2M8 7H6a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2v-2" /></svg>
                                        From template
                                    </button>
                                    <button
                                        onClick={() => { setShowCreateMenu(false); toast.info("Import contract coming soon"); }}
                                        className="w-full flex items-center gap-3 px-4 py-3 text-sm text-slate-700 hover:bg-slate-50 transition text-left border-t border-slate-100"
                                    >
                                        <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
                                        Import Contract
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                {/* AI Draft Panel */}
                {showDraftPanel && draftedHtml && (
                    <div className="fixed inset-0 z-[200] flex items-center justify-center">
                        <div className="fixed inset-0 bg-black/40" onClick={() => setShowDraftPanel(false)} />
                        <div className="relative bg-white rounded-xl shadow-2xl max-w-3xl w-full mx-4 max-h-[85vh] flex flex-col">
                            <div className="flex items-center justify-between p-5 border-b border-hui-border">
                                <div className="flex items-center gap-2">
                                    <span className="text-xl">✨</span>
                                    <h2 className="font-bold text-hui-textMain text-lg">AI Drafted Contract</h2>
                                </div>
                                <button onClick={() => setShowDraftPanel(false)} className="text-hui-textMuted hover:text-hui-textMain">
                                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                                </button>
                            </div>
                            <div className="p-5 overflow-y-auto flex-1">
                                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4 text-xs text-amber-800">
                                    ⚠️ Review this AI draft carefully before use. Add it to a contract template for client signing.
                                </div>
                                <div className={CONTRACT_PROSE_CLASSES} dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(draftedHtml, { USE_PROFILES: { html: true } }) }} />
                            </div>
                            <div className="p-4 border-t border-hui-border flex gap-2">
                                <button onClick={() => setShowDraftPanel(false)} className="hui-btn hui-btn-secondary text-sm">Close</button>
                                <button
                                    onClick={() => { navigator.clipboard.writeText(DOMPurify.sanitize(draftedHtml, { USE_PROFILES: { html: true } })); toast.success("Contract HTML copied to clipboard"); }}
                                    className="hui-btn text-sm"
                                >
                                    Copy HTML
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {/* Contract List */}
                {initialContracts.length === 0 ? (
                    <div className="text-center py-16 bg-white border border-slate-200 rounded-xl shadow-sm">
                        <svg className="w-14 h-14 text-slate-200 mx-auto mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                        <p className="text-slate-500 font-medium text-lg mb-1">No contracts yet</p>
                        <p className="text-sm text-slate-400 mb-6">Create a contract or lien release from a template to get started.</p>
                        <button onClick={() => setShowCreateMenu(true)} className="hui-btn hui-btn-primary text-sm">+ Create Contract</button>
                    </div>
                ) : (
                    <div className="space-y-3">
                        {initialContracts.map((c: any) => (
                            <div key={c.id} className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 hover:shadow-md transition group">
                                <div className="flex items-start justify-between">
                                    <div className="min-w-0 cursor-pointer flex-1" onClick={() => openEditor(c)}>
                                        <div className="flex items-center gap-2 mb-1.5">
                                            <h3 className="font-semibold text-hui-textMain truncate">{c.title}</h3>
                                            <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${STATUS_COLORS[c.status] || STATUS_COLORS.Draft}`}>{c.status}</span>
                                            {c.recurringDays && (
                                                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-indigo-50 text-indigo-600 border border-indigo-200">🔄 Every {c.recurringDays}d</span>
                                            )}
                                        </div>
                                        <div className="flex items-center flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500">
                                            <span>Created {new Date(c.createdAt).toLocaleDateString()}</span>
                                            {c.sentAt && <span>· Sent {new Date(c.sentAt).toLocaleDateString()}</span>}
                                            {c.approvedBy && c.approvedAt && (
                                                <span className="text-green-600 font-medium">· Signed by {c.approvedBy} on {new Date(c.approvedAt).toLocaleDateString()}</span>
                                            )}
                                            {c.contractorSignedBy && (
                                                <span className="text-violet-600 font-medium flex items-center gap-1">
                                                    · Contractor: {c.contractorSignedBy}
                                                    {c.contractorSignatureUrl && <img src={c.contractorSignatureUrl} alt="sig" className="h-5 object-contain ml-1 opacity-80" />}
                                                </span>
                                            )}
                                            {c.nextDueDate && <span className="text-indigo-600">· Next due {new Date(c.nextDueDate).toLocaleDateString()}</span>}
                                            {c.status === "Signed" && c.requiresCountersign && !c.companySignedBy && (
                                                <span className="text-amber-600 font-medium">· Awaiting company countersignature</span>
                                            )}
                                            {c.companySignedBy && c.companySignedAt && (
                                                <span className="text-indigo-600 font-medium">· Countersigned by {c.companySignedBy} on {new Date(c.companySignedAt).toLocaleDateString()}</span>
                                            )}
                                        </div>
                                        {c.signingRecords?.length > 0 && (
                                            <p className="text-[10px] text-slate-400 mt-1">{c.signingRecords.length} signing record{c.signingRecords.length !== 1 ? "s" : ""}</p>
                                        )}
                                    </div>
                                    <div className="flex items-center gap-2 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto transition shrink-0">
                                        <button onClick={() => openEditor(c)} className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200 transition border border-slate-200">
                                            ✏️ Edit
                                        </button>
                                        {c.recurringDays && (
                                            <button onClick={() => handleViewHistory(c.id)} className="px-3 py-1.5 text-xs font-medium text-indigo-700 bg-indigo-50 rounded-lg hover:bg-indigo-100 transition border border-indigo-200">
                                                📋 History
                                            </button>
                                        )}
                                        {c.executedPdfUrl && (
                                            <a href={c.executedPdfUrl} target="_blank" rel="noopener noreferrer"
                                                onClick={e => e.stopPropagation()}
                                                className="px-3 py-1.5 text-xs font-medium text-green-700 bg-green-50 rounded-lg hover:bg-green-100 transition border border-green-200"
                                                title="Download signed PDF"
                                            >
                                                ⬇ PDF
                                            </a>
                                        )}
                                        {c.contractorSignedBy ? (
                                            <span className="px-3 py-1.5 text-xs font-medium rounded-lg border text-violet-700 bg-violet-50 border-violet-200 flex items-center gap-1">
                                                ✓ Contractor Signed
                                            </span>
                                        ) : (
                                            <button onClick={() => setContractorSignModal(c)}
                                                className="px-3 py-1.5 text-xs font-medium rounded-lg transition border text-violet-700 bg-violet-50 border-violet-200 hover:bg-violet-100"
                                                title="Sign as contractor"
                                            >
                                                ✍ Sign as Contractor
                                            </button>
                                        )}
                                        {c.status === "Signed" && c.requiresCountersign && (
                                            c.companySignedBy ? (
                                                <span className="px-3 py-1.5 text-xs font-medium rounded-lg border text-indigo-700 bg-indigo-50 border-indigo-200 flex items-center gap-1">
                                                    ✓ Company Signed
                                                </span>
                                            ) : (
                                                <button onClick={() => setCompanyCountersignModal(c)}
                                                    className="px-3 py-1.5 text-xs font-medium rounded-lg transition border text-indigo-700 bg-indigo-50 border-indigo-200 hover:bg-indigo-100"
                                                    title="Countersign as the company to fully execute this contract"
                                                >
                                                    🖋 Countersign as Company
                                                </button>
                                            )
                                        )}
                                        {(c.status === "Draft" || c.status === "Sent") && (
                                            <button onClick={() => handleSend(c.id)} className="px-3 py-1.5 text-xs font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition shadow-sm">
                                                {c.status === "Sent" ? "Resend" : "Send"}
                                            </button>
                                        )}
                                        <button onClick={() => handleDelete(c.id)} className="px-3 py-1.5 text-xs font-medium text-slate-500 hover:text-red-600 transition">
                                            Delete
                                        </button>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* ── TEMPLATE CHOOSER MODAL ── */}
            {showTemplateModal && (
                <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setShowTemplateModal(false)}>
                    <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full max-h-[80vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
                        <div className="px-6 pt-6 pb-4 border-b border-slate-200 flex items-center justify-between">
                            <h2 className="text-xl font-bold text-slate-800">Choose Template</h2>
                            <button onClick={() => setShowTemplateModal(false)} className="text-slate-400 hover:text-slate-600 transition text-xl leading-none">×</button>
                        </div>
                        <div className="px-6 py-4 flex items-center justify-between gap-4 border-b border-slate-100">
                            <div>
                                <h3 className="text-sm font-semibold text-slate-700 mb-2">Templates</h3>
                                <div className="relative">
                                    <svg className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                                    <input
                                        type="text"
                                        value={templateSearch}
                                        onChange={e => setTemplateSearch(e.target.value)}
                                        placeholder="Search Templates"
                                        className="pl-9 pr-4 py-2 text-sm border border-slate-200 rounded-lg outline-none focus:ring-2 focus:ring-green-200 focus:border-green-400 w-56 transition"
                                        autoFocus
                                    />
                                </div>
                            </div>
                            <a href="/company/templates" className="text-sm font-medium text-slate-600 hover:text-green-700 transition whitespace-nowrap">
                                Manage Templates
                            </a>
                        </div>
                        <div className="flex-1 overflow-y-auto">
                            {filteredTemplates.length === 0 ? (
                                <div className="text-center py-12 text-slate-400">
                                    <p className="text-sm">No templates found.</p>
                                    <p className="text-xs mt-1">Go to Company → Templates to create one.</p>
                                </div>
                            ) : (
                                <div className="divide-y divide-slate-100">
                                    {filteredTemplates.map(t => (
                                        <button
                                            key={t.id}
                                            onClick={() => handleTemplateChange(t.id)}
                                            className={`w-full text-left px-6 py-4 hover:bg-slate-50 transition flex items-center justify-between ${selectedTemplate === t.id ? "bg-green-50 border-l-4 border-green-500" : ""}`}
                                        >
                                            <div>
                                                <p className="text-sm font-medium text-slate-800 uppercase tracking-wide">{t.name}</p>
                                                <p className="text-xs text-slate-400 mt-0.5">{TYPE_LABEL[t.type] ?? t.type}</p>
                                            </div>
                                            {selectedTemplate === t.id && (
                                                <svg className="w-5 h-5 text-green-600 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
                                            )}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                        <div className="px-6 py-4 border-t border-slate-200 bg-slate-50 space-y-4">
                            <div className="bg-white border border-slate-200 rounded-lg p-3">
                                <label className="flex items-center gap-3 cursor-pointer">
                                    <input type="checkbox" checked={isRecurring} onChange={e => setIsRecurring(e.target.checked)} className="w-4 h-4 text-indigo-600 border-slate-300 rounded" />
                                    <div>
                                        <span className="text-sm font-medium text-slate-800">Recurring signing</span>
                                        <p className="text-xs text-slate-500 mt-0.5">Client signs again at the interval below</p>
                                    </div>
                                </label>
                                {isRecurring && (
                                    <div className="mt-3 flex items-center gap-2 pl-7">
                                        <span className="text-sm text-slate-600">Every</span>
                                        <input type="number" min={1} value={recurringDays} onChange={e => setRecurringDays(parseInt(e.target.value) || 30)} className="hui-input w-20 text-center text-sm py-1" />
                                        <span className="text-sm text-slate-600">days</span>
                                    </div>
                                )}
                            </div>
                            <div className="flex gap-3 justify-end">
                                <button onClick={() => { setShowTemplateModal(false); setIsRecurring(false); }} className="hui-btn hui-btn-secondary px-4 py-2">Cancel</button>
                                <button onClick={handleCreateFromTemplate} disabled={!selectedTemplate || isCreating} className="hui-btn hui-btn-primary px-4 py-2">
                                    {isCreating ? "Creating..." : "Create Contract"}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* ── SIGNING HISTORY MODAL ── */}
            {historyModal && (
                <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
                    <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full p-6 max-h-[80vh] overflow-hidden flex flex-col">
                        <div className="flex items-center justify-between mb-4">
                            <h3 className="text-lg font-bold text-hui-textMain">Signing History</h3>
                            <button onClick={() => setHistoryModal(null)} className="text-slate-400 hover:text-slate-600 text-xl">&times;</button>
                        </div>
                        <div className="flex-1 overflow-y-auto">
                            {loadingHistory ? (
                                <div className="text-center py-8 text-slate-500">
                                    <div className="w-6 h-6 border-2 border-slate-300 border-t-indigo-500 rounded-full animate-spin mx-auto mb-2"></div>
                                    Loading...
                                </div>
                            ) : signingHistory.length === 0 ? (
                                <div className="text-center py-8 text-slate-500 text-sm">No signing records yet.</div>
                            ) : (
                                <div className="space-y-3">
                                    {signingHistory.map((r, idx) => (
                                        <div key={r.id} className="bg-slate-50 rounded-lg p-4 border border-slate-100">
                                            <div className="flex items-start justify-between">
                                                <div>
                                                    <div className="flex items-center gap-2 mb-1">
                                                        <span className="w-5 h-5 bg-green-100 text-green-700 rounded-full flex items-center justify-center text-[10px] font-bold">{signingHistory.length - idx}</span>
                                                        <span className="font-semibold text-sm text-slate-800">{r.signedBy}</span>
                                                    </div>
                                                    <p className="text-xs text-slate-500 pl-7">{new Date(r.signedAt).toLocaleString()}</p>
                                                    {r.periodStart && r.periodEnd && (
                                                        <p className="text-xs text-slate-400 pl-7 mt-0.5">Period: {new Date(r.periodStart).toLocaleDateString()} – {new Date(r.periodEnd).toLocaleDateString()}</p>
                                                    )}
                                                </div>
                                                {r.signatureUrl && <img src={r.signatureUrl} alt="Signature" className="h-8 object-contain opacity-60" />}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* ── CONTRACTOR SIGN MODAL ── */}
            <DocumentSignModal
                isOpen={!!contractorSignModal}
                onClose={() => setContractorSignModal(null)}
                mode="signature"
                onSign={handleContractorSign}
            />

            {/* ── COMPANY COUNTERSIGN MODAL ── */}
            <DocumentSignModal
                isOpen={!!companyCountersignModal}
                onClose={() => setCompanyCountersignModal(null)}
                mode="signature"
                onSign={handleCompanyCountersign}
            />

            {/* ── SEND CONTRACT DIALOG (editable CC) ── */}
            {sendDialog && (
                <div className="fixed inset-0 bg-black/40 z-[60] flex items-center justify-center p-4" onClick={() => !sendingDialog && setSendDialog(null)}>
                    <div className="bg-white rounded-xl shadow-2xl max-w-md w-full p-6" onClick={e => e.stopPropagation()}>
                        <h3 className="text-lg font-bold text-slate-800 mb-1">Send Contract</h3>
                        <p className="text-sm text-slate-500 mb-4">Review who receives this contract before sending.</p>
                        <div className="space-y-3">
                            <div>
                                <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wide mb-1">To</label>
                                <input type="text" value={sendDialog.toEmail} readOnly className="hui-input w-full bg-slate-50 text-slate-600" />
                            </div>
                            <div>
                                <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wide mb-1">CC (comma-separated)</label>
                                <input
                                    type="text"
                                    value={sendDialog.cc}
                                    onChange={e => setSendDialog({ ...sendDialog, cc: e.target.value })}
                                    placeholder="spouse@example.com, manager@company.com"
                                    className="hui-input w-full"
                                />
                                <p className="text-[11px] text-slate-400 mt-1">Prefilled with the client's additional email and the assigned manager. Edit as needed.</p>
                            </div>
                        </div>
                        <div className="flex gap-3 justify-end mt-6">
                            <button onClick={() => setSendDialog(null)} disabled={sendingDialog} className="hui-btn hui-btn-secondary">Cancel</button>
                            <button onClick={confirmSend} disabled={sendingDialog} className="hui-btn hui-btn-primary">{sendingDialog ? "Sending…" : "Send Contract"}</button>
                        </div>
                    </div>
                </div>
            )}

            {/* ── CONTRACTOR-FIRST SIGNING PROMPT ── */}
            {showContractorSignPrompt && pendingSendContractId && (
                <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
                    <div className="bg-white rounded-xl shadow-2xl max-w-md w-full p-6">
                        <div className="w-12 h-12 mx-auto bg-amber-100 text-amber-600 rounded-full flex items-center justify-center mb-4">
                            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" /></svg>
                        </div>
                        <h3 className="text-lg font-bold text-slate-800 text-center mb-2">Contractor Signature Required</h3>
                        <p className="text-sm text-slate-500 text-center mb-6">This contract includes a contractor signature block. You must sign as contractor before sending to the client.</p>
                        <div className="flex flex-col gap-2">
                            <button
                                onClick={() => {
                                    setShowContractorSignPrompt(false);
                                    const contract = initialContracts.find((c: any) => c.id === pendingSendContractId);
                                    setPendingSendContractId(null);
                                    if (contract) setContractorSignModal(contract);
                                }}
                                className="w-full px-4 py-2.5 text-sm font-semibold text-white bg-violet-600 hover:bg-violet-700 rounded-lg transition"
                            >
                                Sign as Contractor Now
                            </button>
                            <button
                                onClick={() => { setShowContractorSignPrompt(false); setPendingSendContractId(null); }}
                                className="w-full px-4 py-2 text-sm text-slate-400 hover:text-slate-600 transition"
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Click-away to close create menu */}
            {showCreateMenu && <div className="fixed inset-0 z-20" onClick={() => setShowCreateMenu(false)} />}
        </div>
    );
}
