"use client";

import { useState, useRef } from "react";
import { createContractFromTemplate, sendContractToClient, deleteContract, getContractSigningHistory, updateContract } from "@/lib/actions";
import { toast } from "sonner";

interface Template { id: string; name: string; type: string; }
interface SigningRecord {
    id: string; signedBy: string; signedAt: string | Date;
    periodStart?: string | Date | null; periodEnd?: string | Date | null;
    signatureUrl?: string | null;
}

// ─── MERGE FIELDS ───
const MERGE_FIELDS = [
    {
        category: "Client", icon: "👤", color: "blue",
        fields: [
            { key: "client_name", label: "Name", example: "John Doe" },
            { key: "client_email", label: "Email", example: "john@example.com" },
            { key: "client_phone", label: "Phone", example: "(555) 123-4567" },
            { key: "client_address", label: "Address", example: "123 Main St, Los Angeles, CA 90001" },
        ]
    },
    {
        category: "Company", icon: "🏢", color: "purple",
        fields: [
            { key: "company_name", label: "Name", example: "Golden Touch Remodeling" },
            { key: "company_address", label: "Address", example: "456 Business Ave" },
            { key: "company_phone", label: "Phone", example: "(555) 987-6543" },
            { key: "company_email", label: "Email", example: "info@company.com" },
        ]
    },
    {
        category: "Project", icon: "📋", color: "green",
        fields: [
            { key: "project_name", label: "Name", example: "Kitchen Remodel" },
            { key: "location", label: "Location", example: "123 Main St, Los Angeles" },
            { key: "estimate_total", label: "Estimate Total", example: "$45,000" },
        ]
    },
    {
        category: "Date", icon: "📅", color: "amber",
        fields: [
            { key: "date", label: "Today's Date", example: "March 10, 2026" },
            { key: "year", label: "Year", example: "2026" },
        ]
    },
    {
        category: "Signing", icon: "✍️", color: "rose",
        fields: [
            { key: "SIGNATURE_BLOCK", label: "Signature", example: "[ Click to Sign ]" },
            { key: "INITIAL_BLOCK", label: "Initials", example: "[ Click to Initial ]" },
            { key: "DATE_BLOCK", label: "Signed Date", example: "3/27/2026" },
        ]
    }
];

const categoryColors: Record<string, { pill: string }> = {
    blue: { pill: "bg-blue-100 text-blue-700 hover:bg-blue-200" },
    purple: { pill: "bg-purple-100 text-purple-700 hover:bg-purple-200" },
    green: { pill: "bg-green-100 text-green-700 hover:bg-green-200" },
    amber: { pill: "bg-amber-100 text-amber-700 hover:bg-amber-200" },
    rose: { pill: "bg-rose-100 text-rose-700 hover:bg-rose-200" },
};

function resolvePreview(html: string): string {
    const data: Record<string, string> = {};
    MERGE_FIELDS.forEach(cat => cat.fields.forEach(f => { data[f.key] = f.example; }));
    data.date = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    data.year = new Date().getFullYear().toString();
    return html.replace(/\{\{(\w+)\}\}/g, (match, key) => {
        const value = data[key];
        if (value) return `<span style="background: #dbeafe; padding: 1px 4px; border-radius: 4px; font-weight: 600;">${value}</span>`;
        return `<span style="background: #fef3c7; padding: 1px 4px; border-radius: 4px; color: #92400e;">${match}</span>`;
    });
}

export default function ProjectContractsClient({ projectId, projectName, clientName, contracts: initialContracts, templates }: {
    projectId: string;
    projectName: string;
    clientName: string;
    contracts: any[];
    templates: Template[];
}) {
    const [showModal, setShowModal] = useState(false);
    const [selectedTemplate, setSelectedTemplate] = useState("");
    const [isCreating, setIsCreating] = useState(false);
    const [isRecurring, setIsRecurring] = useState(false);
    const [recurringDays, setRecurringDays] = useState(30);
    const [historyModal, setHistoryModal] = useState<string | null>(null);
    const [signingHistory, setSigningHistory] = useState<SigningRecord[]>([]);
    const [loadingHistory, setLoadingHistory] = useState(false);
    const [isDraftingContract, setIsDraftingContract] = useState(false);
    const [showDraftPanel, setShowDraftPanel] = useState(false);
    const [draftedHtml, setDraftedHtml] = useState<string | null>(null);

    // ─── EDITOR STATE ───
    const [editingContract, setEditingContract] = useState<any>(null);
    const [editTitle, setEditTitle] = useState("");
    const [editBody, setEditBody] = useState("");
    const [activeTab, setActiveTab] = useState<"edit" | "preview">("edit");
    const [saving, setSaving] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    const contractTemplates = templates.filter(t => t.type === "contract" || t.type === "lien_release");

    // ─── EDITOR HELPERS ───
    const insertMergeField = (key: string) => {
        const ta = textareaRef.current;
        if (!ta) return;
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        const tag = `{{${key}}}`;
        const newBody = editBody.substring(0, start) + tag + editBody.substring(end);
        setEditBody(newBody);
        setTimeout(() => { ta.focus(); ta.selectionStart = ta.selectionEnd = start + tag.length; }, 0);
    };

    const insertHtmlTag = (tag: string, placeholder?: string) => {
        const ta = textareaRef.current;
        if (!ta) return;
        const start = ta.selectionStart;
        const selfClosing = ["hr", "br"].includes(tag);
        let snippet: string;
        if (selfClosing) { snippet = `<${tag}/>`; }
        else if (tag === "ul") { snippet = `<ul>\n  <li>Item 1</li>\n  <li>Item 2</li>\n</ul>`; }
        else { snippet = `<${tag}>${placeholder || ""}</${tag}>`; }
        const newBody = editBody.substring(0, start) + snippet + editBody.substring(ta.selectionEnd);
        setEditBody(newBody);
        setTimeout(() => { ta.focus(); }, 0);
    };

    const openEditor = (contract: any) => {
        setEditingContract(contract);
        setEditTitle(contract.title);
        setEditBody(contract.body);
        setActiveTab("edit");
    };

    const handleSaveEdit = async () => {
        if (!editingContract) return;
        setSaving(true);
        try {
            await updateContract(editingContract.id, { title: editTitle, body: editBody });
            toast.success("Contract updated!");
            setEditingContract(null);
            window.location.reload();
        } catch (e: any) {
            toast.error(e.message || "Failed to update contract");
        } finally { setSaving(false); }
    };

    async function handleDraftContract() {
        setIsDraftingContract(true);
        try {
            const res = await fetch("/api/ai/draft-contract", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ projectId }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "Draft failed");
            setDraftedHtml(data.contractHtml);
            setShowDraftPanel(true);
        } catch (e: any) {
            toast.error(e.message || "Contract drafting failed");
        } finally {
            setIsDraftingContract(false);
        }
    }

    const handleCreate = async () => {
        if (!selectedTemplate) return;
        setIsCreating(true);
        try {
            await createContractFromTemplate(selectedTemplate, { type: "project", id: projectId }, undefined, isRecurring ? recurringDays : undefined);
            toast.success("Contract created!");
            setShowModal(false); setSelectedTemplate(""); setIsRecurring(false);
            window.location.reload();
        } catch (e: any) { toast.error(e.message || "Failed to create"); }
        finally { setIsCreating(false); }
    };

    const handleSend = async (contractId: string) => {
        try {
            const result = await sendContractToClient(contractId);
            toast.success(`Sent to ${result.sentTo}`);
            window.location.reload();
        } catch (e: any) { toast.error(e.message || "Failed to send"); }
    };

    const handleDelete = async (contractId: string) => {
        if (!confirm("Delete this contract?")) return;
        try { await deleteContract(contractId); toast.success("Deleted"); window.location.reload(); }
        catch { toast.error("Failed to delete"); }
    };

    const handleViewHistory = async (contractId: string) => {
        setHistoryModal(contractId);
        setLoadingHistory(true);
        try { const records = await getContractSigningHistory(contractId) as SigningRecord[]; setSigningHistory(records); }
        catch { toast.error("Failed to load history"); }
        finally { setLoadingHistory(false); }
    };

    const handleTemplateChange = (templateId: string) => {
        setSelectedTemplate(templateId);
        const t = templates.find(t => t.id === templateId);
        if (t?.type === "lien_release") { setIsRecurring(true); setRecurringDays(30); }
    };

    const statusColors: Record<string, string> = {
        Draft: "bg-gray-100 text-gray-700 border-gray-200",
        Sent: "bg-blue-100 text-blue-700 border-blue-200",
        Viewed: "bg-yellow-100 text-yellow-700 border-yellow-200",
        Signed: "bg-green-100 text-green-700 border-green-200",
        Declined: "bg-red-100 text-red-700 border-red-200",
    };

    // ─── FULL-SCREEN EDITOR ───
    if (editingContract) {
        return (
            <div className="fixed inset-0 z-50 font-sans text-slate-900 flex flex-col bg-white">
                {/* Editor Header */}
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
                            <p className="text-xs text-slate-400">{projectName} · {clientName}</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-3">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${statusColors[editingContract.status] || statusColors.Draft}`}>
                            {editingContract.status}
                        </span>
                        <button onClick={() => setEditingContract(null)} className="px-3 py-1.5 text-sm text-slate-500 hover:text-slate-700 border border-slate-200 rounded-lg transition">Cancel</button>
                        <button onClick={handleSaveEdit} disabled={saving} className="px-4 py-1.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition shadow-sm disabled:opacity-50">
                            {saving ? "Saving..." : "Save Changes"}
                        </button>
                    </div>
                </header>

                {/* Merge Field Toolbar */}
                <div className="bg-slate-50 border-b border-slate-200 px-6 py-3 shrink-0">
                    <div className="flex items-start gap-4 flex-wrap">
                        <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider pt-1.5 shrink-0">Insert Field:</span>
                        {MERGE_FIELDS.map(cat => (
                            <div key={cat.category} className="flex items-center gap-1.5">
                                <span className="text-xs font-semibold text-slate-500">{cat.icon} {cat.category}:</span>
                                <div className="flex gap-1 flex-wrap">
                                    {cat.fields.map(f => (
                                        <button
                                            key={f.key}
                                            onClick={() => insertMergeField(f.key)}
                                            className={`px-2 py-0.5 rounded-full text-xs font-medium transition cursor-pointer ${categoryColors[cat.color].pill}`}
                                            title={`Inserts {{${f.key}}} → "${f.example}"`}
                                        >{f.label}</button>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                {/* HTML Format Toolbar */}
                <div className="bg-white border-b border-slate-200 px-6 py-2 shrink-0 flex items-center gap-1">
                    <span className="text-xs font-semibold text-slate-500 mr-2">Format:</span>
                    <button onClick={() => insertHtmlTag("h2", "Heading")} className="px-2 py-1 text-xs rounded hover:bg-slate-100 font-bold transition">H2</button>
                    <button onClick={() => insertHtmlTag("h3", "Subheading")} className="px-2 py-1 text-xs rounded hover:bg-slate-100 font-semibold transition">H3</button>
                    <button onClick={() => insertHtmlTag("strong", "bold text")} className="px-2 py-1 text-xs rounded hover:bg-slate-100 font-bold transition"><b>B</b></button>
                    <button onClick={() => insertHtmlTag("em", "italic text")} className="px-2 py-1 text-xs rounded hover:bg-slate-100 italic transition"><em>I</em></button>
                    <button onClick={() => insertHtmlTag("p", "Paragraph text")} className="px-2 py-1 text-xs rounded hover:bg-slate-100 transition">¶</button>
                    <button onClick={() => insertHtmlTag("ul")} className="px-2 py-1 text-xs rounded hover:bg-slate-100 transition">• List</button>
                    <button onClick={() => insertHtmlTag("li", "List item")} className="px-2 py-1 text-xs rounded hover:bg-slate-100 transition">— Item</button>
                    <div className="w-px h-5 bg-slate-200 mx-1"></div>
                    <button onClick={() => insertHtmlTag("hr")} className="px-2 py-1 text-xs rounded hover:bg-slate-100 transition">― Line</button>
                    <button onClick={() => insertHtmlTag("br")} className="px-2 py-1 text-xs rounded hover:bg-slate-100 transition">↵ Break</button>
                </div>

                {/* Tab Switcher (mobile) + Split Pane */}
                <div className="flex-1 flex flex-col overflow-hidden">
                    <div className="lg:hidden flex border-b border-slate-200 shrink-0">
                        <button onClick={() => setActiveTab("edit")} className={`flex-1 py-2 text-sm font-medium text-center transition ${activeTab === "edit" ? "bg-white border-b-2 border-blue-500 text-blue-600" : "bg-slate-50 text-slate-500"}`}>✏️ Editor</button>
                        <button onClick={() => setActiveTab("preview")} className={`flex-1 py-2 text-sm font-medium text-center transition ${activeTab === "preview" ? "bg-white border-b-2 border-blue-500 text-blue-600" : "bg-slate-50 text-slate-500"}`}>👁️ Preview</button>
                    </div>

                    <div className="flex-1 flex overflow-hidden">
                        {/* Editor Pane */}
                        <div className={`flex-1 flex flex-col border-r border-slate-200 ${activeTab === "preview" ? "hidden lg:flex" : ""}`}>
                            <div className="px-4 py-2 bg-slate-50 text-xs font-semibold text-slate-500 uppercase tracking-wider border-b border-slate-200 shrink-0">
                                HTML Source
                            </div>
                            <textarea
                                ref={textareaRef}
                                className="flex-1 w-full p-4 font-mono text-sm text-slate-800 bg-white resize-none outline-none border-none leading-relaxed"
                                placeholder={"Edit your contract content here...\n\nUse merge field buttons above to insert {{client_name}} etc.\nUse format buttons to add HTML tags."}
                                value={editBody}
                                onChange={e => setEditBody(e.target.value)}
                                spellCheck={false}
                            />
                        </div>

                        {/* Preview Pane */}
                        <div className={`flex-1 flex flex-col bg-slate-100 ${activeTab === "edit" ? "hidden lg:flex" : ""}`}>
                            <div className="px-4 py-2 bg-slate-50 text-xs font-semibold text-slate-500 uppercase tracking-wider border-b border-slate-200 shrink-0 flex items-center justify-between">
                                <span>Live Preview</span>
                                <span className="text-[10px] font-normal normal-case">Shows resolved merge fields</span>
                            </div>
                            <div className="flex-1 overflow-auto p-6">
                                <div className="bg-white rounded-xl shadow-lg border border-slate-200 max-w-2xl mx-auto overflow-hidden">
                                    {/* Document Header */}
                                    <div className="bg-gradient-to-r from-slate-800 to-slate-700 px-8 py-6 text-white">
                                        <div className="flex items-center gap-4">
                                            <img src="/logo.png" alt="Logo" className="h-12 w-auto object-contain rounded bg-white p-1" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}/>
                                            <div>
                                                <h1 className="text-lg font-bold">Golden Touch Remodeling</h1>
                                                <p className="text-sm text-slate-300">{projectName}</p>
                                            </div>
                                        </div>
                                    </div>

                                    {/* Document Body */}
                                    <div className="p-8">
                                        {editBody ? (
                                            <div
                                                className="prose prose-sm max-w-none prose-headings:text-slate-800 prose-headings:font-semibold prose-p:text-slate-600 prose-p:leading-relaxed prose-strong:text-slate-800 prose-li:text-slate-600"
                                                dangerouslySetInnerHTML={{ __html: resolvePreview(editBody) }}
                                            />
                                        ) : (
                                            <div className="text-center py-16 text-slate-400">
                                                <p className="text-sm">Start editing to see a live preview</p>
                                            </div>
                                        )}
                                    </div>

                                    {/* Signature Placeholder */}
                                    <div className="px-8 pb-8">
                                        <div className="border-t-2 border-dotted border-slate-300 pt-6 mt-4">
                                            <div className="grid grid-cols-2 gap-8">
                                                <div>
                                                    <div className="border-b border-slate-300 pb-8 mb-2"></div>
                                                    <p className="text-xs text-slate-400">Client Signature</p>
                                                </div>
                                                <div>
                                                    <div className="border-b border-slate-300 pb-8 mb-2"></div>
                                                    <p className="text-xs text-slate-400">Date</p>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    // ─── CONTRACT LIST ───
    return (
        <div>
            <div className="flex items-center justify-between mb-6">
                <div>
                    <h1 className="text-xl font-bold text-hui-textMain">Contracts & Lien Releases</h1>
                    <p className="text-sm text-hui-textMuted">{projectName} · {clientName}</p>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={handleDraftContract}
                        disabled={isDraftingContract}
                        className="hui-btn bg-gradient-to-r from-purple-50 to-indigo-50 border-purple-200 text-purple-700 hover:from-purple-100 hover:to-indigo-100 text-sm flex items-center gap-1.5 disabled:opacity-50"
                    >
                        ✨ {isDraftingContract ? "Drafting…" : "AI Draft Contract"}
                    </button>
                    <button onClick={() => setShowModal(true)} className="hui-btn hui-btn-primary">+ Create</button>
                </div>
            </div>

            {/* AI Draft Contract Panel */}
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
                            <div
                                className="prose prose-sm max-w-none"
                                dangerouslySetInnerHTML={{ __html: draftedHtml }}
                            />
                        </div>
                        <div className="p-4 border-t border-hui-border flex gap-2">
                            <button onClick={() => setShowDraftPanel(false)} className="hui-btn hui-btn-secondary text-sm">Close</button>
                            <button
                                onClick={() => {
                                    navigator.clipboard.writeText(draftedHtml);
                                    toast.success("Contract HTML copied to clipboard");
                                }}
                                className="hui-btn text-sm"
                            >
                                Copy HTML
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {initialContracts.length === 0 ? (
                <div className="text-center py-16 bg-white border border-slate-200 rounded-xl">
                    <svg className="w-12 h-12 text-slate-300 mx-auto mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                    <p className="text-slate-500 font-medium">No contracts yet</p>
                    <p className="text-xs text-slate-400 mt-1 mb-4">Create a contract or lien release from a template.</p>
                    <button onClick={() => setShowModal(true)} className="hui-btn hui-btn-primary text-sm">+ Create Contract</button>
                </div>
            ) : (
                <div className="space-y-3">
                    {initialContracts.map((c: any) => (
                        <div key={c.id} className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 hover:shadow-md transition group">
                            <div className="flex items-start justify-between">
                                <div className="min-w-0">
                                    <div className="flex items-center gap-2 mb-1.5">
                                        <h3 className="font-semibold text-hui-textMain truncate">{c.title}</h3>
                                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${statusColors[c.status] || statusColors.Draft}`}>{c.status}</span>
                                        {c.recurringDays && (
                                            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-indigo-50 text-indigo-600 border border-indigo-200">🔄 Every {c.recurringDays}d</span>
                                        )}
                                    </div>
                                    <div className="flex items-center gap-3 text-xs text-slate-500">
                                        <span>Created {new Date(c.createdAt).toLocaleDateString()}</span>
                                        {c.sentAt && <span>· Sent {new Date(c.sentAt).toLocaleDateString()}</span>}
                                        {c.approvedBy && <span className="text-green-600 font-medium">· Signed by {c.approvedBy}</span>}
                                        {c.nextDueDate && <span className="text-indigo-600">· Next due {new Date(c.nextDueDate).toLocaleDateString()}</span>}
                                    </div>
                                    {c.signingRecords?.length > 0 && (
                                        <p className="text-[10px] text-slate-400 mt-1">{c.signingRecords.length} signing record{c.signingRecords.length !== 1 ? "s" : ""}</p>
                                    )}
                                </div>
                                <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition shrink-0">
                                    <button onClick={() => openEditor(c)} className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200 transition border border-slate-200">
                                        ✏️ Edit
                                    </button>
                                    {c.recurringDays && (
                                        <button onClick={() => handleViewHistory(c.id)} className="px-3 py-1.5 text-xs font-medium text-indigo-700 bg-indigo-50 rounded-lg hover:bg-indigo-100 transition border border-indigo-200">
                                            📋 History
                                        </button>
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

            {/* Create Modal */}
            {showModal && (
                <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
                    <div className="bg-white rounded-xl shadow-2xl max-w-md w-full p-6">
                        <h3 className="text-lg font-bold text-hui-textMain mb-1">Create Contract / Lien Release</h3>
                        <p className="text-sm text-hui-textMuted mb-5">Merge fields will auto-fill from project data.</p>
                        <div className="space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-hui-textMain mb-1">Template</label>
                                <select value={selectedTemplate} onChange={e => handleTemplateChange(e.target.value)} className="hui-input w-full">
                                    <option value="">Select a template...</option>
                                    <optgroup label="Contracts">
                                        {contractTemplates.filter(t => t.type === "contract").map(t => (
                                            <option key={t.id} value={t.id}>{t.name}</option>
                                        ))}
                                    </optgroup>
                                    <optgroup label="Lien Releases">
                                        {contractTemplates.filter(t => t.type === "lien_release").map(t => (
                                            <option key={t.id} value={t.id}>{t.name}</option>
                                        ))}
                                    </optgroup>
                                </select>
                            </div>
                            <div className="bg-slate-50 border border-slate-200 rounded-lg p-4">
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
                            <div className="flex gap-3 justify-end pt-2">
                                <button onClick={() => { setShowModal(false); setIsRecurring(false); }} className="hui-btn hui-btn-secondary px-4 py-2">Cancel</button>
                                <button onClick={handleCreate} disabled={!selectedTemplate || isCreating} className="hui-btn hui-btn-primary px-4 py-2">
                                    {isCreating ? "Creating..." : "Create"}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* History Modal */}
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
        </div>
    );
}
