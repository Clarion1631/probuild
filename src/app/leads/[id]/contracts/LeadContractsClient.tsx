"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { createContractFromTemplate, createContractBlank, sendContractToClient, deleteContract, getContractSigningHistory, updateContract } from "@/lib/actions";
import { toast } from "sonner";

interface Template { id: string; name: string; type: string; }
interface SigningRecord {
    id: string; signedBy: string; signedAt: string;
    periodStart?: string | null; periodEnd?: string | null;
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

export default function LeadContractsClient({ leadId, leadName, clientName, contracts: initialContracts, templates, autoCreate }: {
    leadId: string;
    leadName: string;
    clientName: string;
    contracts: any[];
    templates: Template[];
    autoCreate?: boolean;
}) {
    const router = useRouter();
    const [showCreateMenu, setShowCreateMenu] = useState(false);
    const [showTemplateModal, setShowTemplateModal] = useState(false);
    const [selectedTemplate, setSelectedTemplate] = useState("");
    const [templateSearch, setTemplateSearch] = useState("");
    const [isCreating, setIsCreating] = useState(false);
    const [isRecurring, setIsRecurring] = useState(false);
    const [recurringDays, setRecurringDays] = useState(30);
    const [historyModal, setHistoryModal] = useState<string | null>(null);
    const [signingHistory, setSigningHistory] = useState<SigningRecord[]>([]);
    const [loadingHistory, setLoadingHistory] = useState(false);

    // ─── EDITOR STATE ───
    const [editingContract, setEditingContract] = useState<any>(null);
    const [editTitle, setEditTitle] = useState("");
    const [editBody, setEditBody] = useState("");
    const [activeTab, setActiveTab] = useState<"edit" | "preview">("edit");
    const [saving, setSaving] = useState(false);
    const [editUndoStack, setEditUndoStack] = useState<string[]>([]);
    const [editRedoStack, setEditRedoStack] = useState<string[]>([]);
    const [blankUndoStack, setBlankUndoStack] = useState<string[]>([]);
    const [blankRedoStack, setBlankRedoStack] = useState<string[]>([]);
    const [openDropdown, setOpenDropdown] = useState<string | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const toolbarRef = useRef<HTMLDivElement>(null);
    const editTypingDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const editPreTypingBodyRef = useRef("");
    const editIsTypingRef = useRef(false);
    const blankTypingDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const blankPreTypingBodyRef = useRef("");
    const blankIsTypingRef = useRef(false);
    const editBodyRef = useRef("");
    useEffect(() => { editBodyRef.current = editBody; }, [editBody]);

    // ─── NEW BLANK CONTRACT STATE ───
    const [creatingBlank, setCreatingBlank] = useState(false);
    const [blankTitle, setBlankTitle] = useState("");
    const [blankBody, setBlankBody] = useState("");
    const blankTextareaRef = useRef<HTMLTextAreaElement>(null);
    const blankBodyRef = useRef("");
    useEffect(() => { blankBodyRef.current = blankBody; }, [blankBody]);

    const contractTemplates = templates.filter(t => t.type === "contract" || t.type === "lien_release");

    // Auto-open create menu if navigated with ?action=create
    useEffect(() => {
        if (autoCreate) {
            setShowCreateMenu(true);
        }
    }, [autoCreate]);

    // ─── EDITOR HELPERS ───
    const insertMergeField = (key: string, ref: React.RefObject<HTMLTextAreaElement | null>, body: string, setBody: (v: string) => void, pushUndo: (v: string) => void) => {
        const ta = ref.current;
        if (!ta) return;
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        const tag = `{{${key}}}`;
        pushUndo(body);
        const newBody = body.substring(0, start) + tag + body.substring(end);
        setBody(newBody);
        setTimeout(() => { ta.focus(); ta.selectionStart = ta.selectionEnd = start + tag.length; }, 0);
    };

    const insertHtmlTag = (tag: string, ref: React.RefObject<HTMLTextAreaElement | null>, body: string, setBody: (v: string) => void, pushUndo: (v: string) => void, placeholder?: string) => {
        const ta = ref.current;
        if (!ta) return;
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        const selected = body.substring(start, end);
        pushUndo(body);
        const selfClosing = ["hr", "br"].includes(tag);
        let snippet: string;
        if (selfClosing) { snippet = `<${tag}/>`; }
        else if (tag === "ul") { snippet = `<ul>\n  <li>Item 1</li>\n  <li>Item 2</li>\n</ul>`; }
        else if (selected) { snippet = `<${tag}>${selected}</${tag}>`; }
        else { snippet = `<${tag}>${placeholder || ""}</${tag}>`; }
        const newBody = body.substring(0, start) + snippet + body.substring(end);
        setBody(newBody);
        setTimeout(() => { ta.focus(); }, 0);
    };

    const makeUndoHelpers = (
        undoStack: string[], setUndoStack: React.Dispatch<React.SetStateAction<string[]>>,
        redoStack: string[], setRedoStack: React.Dispatch<React.SetStateAction<string[]>>,
        bodyRef: React.MutableRefObject<string>, setBody: (v: string) => void
    ) => {
        const pushUndo = (value: string) => {
            setUndoStack(prev => [...prev, value].slice(-50));
            setRedoStack([]);
        };
        const handleUndo = () => {
            if (undoStack.length === 0) return;
            const newStack = [...undoStack];
            const prev = newStack.pop()!;
            setRedoStack(r => [bodyRef.current, ...r].slice(0, 50));
            setUndoStack(newStack);
            setBody(prev);
        };
        const handleRedo = () => {
            if (redoStack.length === 0) return;
            const newStack = [...redoStack];
            const next = newStack.shift()!;
            setUndoStack(u => [...u, bodyRef.current].slice(-50));
            setRedoStack(newStack);
            setBody(next);
        };
        return { pushUndo, handleUndo, handleRedo };
    };

    const editHelpers = makeUndoHelpers(editUndoStack, setEditUndoStack, editRedoStack, setEditRedoStack, editBodyRef, setEditBody);
    const blankHelpers = makeUndoHelpers(blankUndoStack, setBlankUndoStack, blankRedoStack, setBlankRedoStack, blankBodyRef, setBlankBody);

    const makeTypingHandler = (
        preTypingRef: React.MutableRefObject<string>,
        isTypingRef: React.MutableRefObject<boolean>,
        debounceRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>,
        setUndoStack: React.Dispatch<React.SetStateAction<string[]>>,
        setRedoStack: React.Dispatch<React.SetStateAction<string[]>>,
        latestBodyRef: React.MutableRefObject<string>,
        setBody: (v: string) => void
    ) => (newBody: string) => {
        if (!isTypingRef.current) {
            preTypingRef.current = latestBodyRef.current;
            isTypingRef.current = true;
            setRedoStack([]); // clear redo at burst start, not debounce end
        }
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
            setUndoStack(prev => [...prev, preTypingRef.current].slice(-50));
            isTypingRef.current = false;
            debounceRef.current = null;
        }, 500);
        setBody(newBody);
    };

    const handleEditBodyChange = makeTypingHandler(editPreTypingBodyRef, editIsTypingRef, editTypingDebounceRef, setEditUndoStack, setEditRedoStack, editBodyRef, setEditBody);
    const handleBlankBodyChange = makeTypingHandler(blankPreTypingBodyRef, blankIsTypingRef, blankTypingDebounceRef, setBlankUndoStack, setBlankRedoStack, blankBodyRef, setBlankBody);

    useEffect(() => {
        if ((!editingContract && !creatingBlank) || !openDropdown) return;
        const handleClickOutside = (e: MouseEvent) => {
            if (toolbarRef.current && !toolbarRef.current.contains(e.target as Node)) {
                setOpenDropdown(null);
            }
        };
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, [editingContract, creatingBlank, openDropdown]);

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

    const handleCreateFromTemplate = async () => {
        if (!selectedTemplate) return;
        setIsCreating(true);
        try {
            const contract = await createContractFromTemplate(selectedTemplate, { type: "lead", id: leadId }, undefined, isRecurring ? recurringDays : undefined);
            toast.success("Contract created!");
            setShowTemplateModal(false); setSelectedTemplate(""); setIsRecurring(false);
            window.location.reload();
        } catch (e: any) { toast.error(e.message || "Failed to create"); }
        finally { setIsCreating(false); }
    };

    const handleCreateBlank = () => {
        setCreatingBlank(true);
        setBlankTitle("");
        setBlankBody("");
        setShowCreateMenu(false);
    };

    const handleSaveBlank = async () => {
        if (!blankTitle.trim()) {
            toast.error("Please enter a contract title");
            return;
        }
        setSaving(true);
        try {
            await createContractBlank({ type: "lead", id: leadId }, blankTitle, blankBody);
            toast.success("Contract created!");
            setCreatingBlank(false);
            window.location.reload();
        } catch (e: any) {
            toast.error(e.message || "Failed to create");
        } finally { setSaving(false); }
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
        try { const records = await getContractSigningHistory(contractId); setSigningHistory(records as unknown as SigningRecord[]); }
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

    const filteredTemplates = contractTemplates.filter(t =>
        t.name.toLowerCase().includes(templateSearch.toLowerCase())
    );

    // ─── RENDER EDITOR TOOLBAR ───
    const renderToolbar = (
        ref: React.RefObject<HTMLTextAreaElement | null>,
        body: string,
        setBody: (v: string) => void,
        undoStack: string[],
        redoStack: string[],
        helpers: { pushUndo: (v: string) => void; handleUndo: () => void; handleRedo: () => void }
    ) => {
        const dataCategories = MERGE_FIELDS.filter(c => c.category !== "Signing");
        const signingCategory = MERGE_FIELDS.find(c => c.category === "Signing")!;
        return (
            <>
                {/* Merge Field Toolbar */}
                <div ref={toolbarRef} className="bg-slate-50 border-b border-slate-200 px-6 py-2.5 shrink-0">
                    <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider shrink-0">Insert:</span>
                        {dataCategories.map(cat => (
                            <div key={cat.category} className="relative">
                                <button
                                    onClick={() => setOpenDropdown(openDropdown === cat.category ? null : cat.category)}
                                    className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md border border-slate-200 bg-white hover:bg-slate-50 text-slate-600 transition"
                                >
                                    <span>{cat.icon}</span>
                                    <span>{cat.category}</span>
                                    <svg className="w-3 h-3 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                                </button>
                                {openDropdown === cat.category && (
                                    <div className="absolute top-full left-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg z-20 min-w-[190px]">
                                        {cat.fields.map(f => (
                                            <button
                                                key={f.key}
                                                onClick={() => { insertMergeField(f.key, ref, body, setBody, helpers.pushUndo); setOpenDropdown(null); }}
                                                className="w-full text-left px-3 py-2 text-xs hover:bg-slate-50 flex items-center justify-between gap-4 group first:rounded-t-lg last:rounded-b-lg"
                                            >
                                                <span className="font-medium text-slate-700">{f.label}</span>
                                                <span className="text-slate-400 text-[10px] truncate max-w-[100px]">"{f.example}"</span>
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                        ))}
                        <div className="w-px h-5 bg-slate-300 mx-1 shrink-0" />
                        <div className="flex items-center gap-1.5 border border-rose-200 rounded-md px-2.5 py-1 bg-rose-50">
                            <span className="text-xs font-semibold text-rose-600 shrink-0">Signing:</span>
                            {signingCategory.fields.map(f => (
                                <button
                                    key={f.key}
                                    onClick={() => insertMergeField(f.key, ref, body, setBody, helpers.pushUndo)}
                                    className="px-2 py-0.5 text-xs font-medium rounded bg-rose-100 text-rose-700 hover:bg-rose-200 transition"
                                    title={`Inserts {{${f.key}}}`}
                                >{f.label}</button>
                            ))}
                        </div>
                    </div>
                </div>

                {/* HTML Format Toolbar */}
                <div className="bg-white border-b border-slate-200 px-6 py-2 shrink-0 flex items-center gap-1 flex-wrap">
                    <span className="text-xs font-semibold text-slate-500 mr-2">Format:</span>
                    <button onClick={() => insertHtmlTag("h2", ref, body, setBody, helpers.pushUndo, "Heading")} className="px-2 py-1 text-xs rounded hover:bg-slate-100 font-bold transition">H2</button>
                    <button onClick={() => insertHtmlTag("h3", ref, body, setBody, helpers.pushUndo, "Subheading")} className="px-2 py-1 text-xs rounded hover:bg-slate-100 font-semibold transition">H3</button>
                    <button onClick={() => insertHtmlTag("strong", ref, body, setBody, helpers.pushUndo, "bold text")} className="px-2 py-1 text-xs rounded hover:bg-slate-100 font-bold transition"><b>B</b></button>
                    <button onClick={() => insertHtmlTag("em", ref, body, setBody, helpers.pushUndo, "italic text")} className="px-2 py-1 text-xs rounded hover:bg-slate-100 italic transition"><em>I</em></button>
                    <button onClick={() => insertHtmlTag("u", ref, body, setBody, helpers.pushUndo, "underlined text")} className="px-2 py-1 text-xs rounded hover:bg-slate-100 underline transition">U</button>
                    <button onClick={() => insertHtmlTag("p", ref, body, setBody, helpers.pushUndo, "Paragraph text")} className="px-2 py-1 text-xs rounded hover:bg-slate-100 transition">¶</button>
                    <button onClick={() => insertHtmlTag("ul", ref, body, setBody, helpers.pushUndo)} className="px-2 py-1 text-xs rounded hover:bg-slate-100 transition">• List</button>
                    <button onClick={() => insertHtmlTag("li", ref, body, setBody, helpers.pushUndo, "List item")} className="px-2 py-1 text-xs rounded hover:bg-slate-100 transition">— Item</button>
                    <div className="w-px h-5 bg-slate-200 mx-1"></div>
                    <button onClick={() => insertHtmlTag("hr", ref, body, setBody, helpers.pushUndo)} className="px-2 py-1 text-xs rounded hover:bg-slate-100 transition">― Line</button>
                    <button onClick={() => insertHtmlTag("br", ref, body, setBody, helpers.pushUndo)} className="px-2 py-1 text-xs rounded hover:bg-slate-100 transition">↵ Break</button>
                    <div className="w-px h-5 bg-slate-200 mx-1"></div>
                    <button onClick={helpers.handleUndo} disabled={undoStack.length === 0} className="px-2 py-1 text-xs rounded hover:bg-slate-100 transition disabled:opacity-30" title="Undo (Ctrl+Z)">↩ Undo</button>
                    <button onClick={helpers.handleRedo} disabled={redoStack.length === 0} className="px-2 py-1 text-xs rounded hover:bg-slate-100 transition disabled:opacity-30" title="Redo (Ctrl+Shift+Z)">↪ Redo</button>
                </div>
            </>
        );
    };

    // ─── RENDER PREVIEW ───
    const renderPreview = (body: string) => (
        <div className="flex-1 overflow-auto p-6">
            <div className="bg-white rounded-xl shadow-lg border border-slate-200 max-w-2xl mx-auto overflow-hidden">
                {/* Document Header */}
                <div className="bg-gradient-to-r from-slate-800 to-slate-700 px-8 py-6 text-white">
                    <div className="flex items-center gap-4">
                        <img src="/logo.png" alt="Logo" className="h-12 w-auto object-contain rounded bg-white p-1" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                        <div>
                            <h1 className="text-lg font-bold">Golden Touch Remodeling</h1>
                            <p className="text-sm text-slate-300">{leadName}</p>
                        </div>
                    </div>
                </div>
                {/* Document Body */}
                <div className="p-8">
                    {body ? (
                        <div
                            className="prose prose-sm max-w-none prose-headings:text-slate-800 prose-headings:font-semibold prose-p:text-slate-600 prose-p:leading-relaxed prose-strong:text-slate-800 prose-li:text-slate-600"
                            dangerouslySetInnerHTML={{ __html: resolvePreview(body) }}
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
    );

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
                            <p className="text-xs text-slate-400">{leadName} · {clientName}</p>
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

                {renderToolbar(blankTextareaRef, blankBody, setBlankBody, blankUndoStack, blankRedoStack, blankHelpers)}

                <div className="flex-1 flex flex-col overflow-hidden">
                    <div className="lg:hidden flex border-b border-slate-200 shrink-0">
                        <button onClick={() => setActiveTab("edit")} className={`flex-1 py-2 text-sm font-medium text-center transition ${activeTab === "edit" ? "bg-white border-b-2 border-blue-500 text-blue-600" : "bg-slate-50 text-slate-500"}`}>✏️ Editor</button>
                        <button onClick={() => setActiveTab("preview")} className={`flex-1 py-2 text-sm font-medium text-center transition ${activeTab === "preview" ? "bg-white border-b-2 border-blue-500 text-blue-600" : "bg-slate-50 text-slate-500"}`}>👁️ Preview</button>
                    </div>
                    <div className="flex-1 flex overflow-hidden">
                        <div className={`flex-1 flex flex-col border-r border-slate-200 ${activeTab === "preview" ? "hidden lg:flex" : ""}`}>
                            <div className="px-4 py-2 bg-slate-50 text-xs font-semibold text-slate-500 uppercase tracking-wider border-b border-slate-200 shrink-0">
                                HTML Source
                            </div>
                            <textarea
                                ref={blankTextareaRef}
                                className="flex-1 w-full p-4 font-mono text-sm text-slate-800 bg-white resize-none outline-none border-none leading-relaxed"
                                placeholder={"Start typing or copy-paste your contract text...\n\nUse Insert dropdowns above to add merge fields.\nCtrl+Z to undo, Ctrl+Shift+Z to redo."}
                                value={blankBody}
                                onChange={e => handleBlankBodyChange(e.target.value)}
                                onKeyDown={e => {
                                    if ((e.ctrlKey || e.metaKey) && e.key === "z") {
                                        e.preventDefault();
                                        if (e.shiftKey) blankHelpers.handleRedo(); else blankHelpers.handleUndo();
                                    }
                                }}
                                spellCheck={false}
                            />
                        </div>
                        <div className={`flex-1 flex flex-col bg-slate-100 ${activeTab === "edit" ? "hidden lg:flex" : ""}`}>
                            <div className="px-4 py-2 bg-slate-50 text-xs font-semibold text-slate-500 uppercase tracking-wider border-b border-slate-200 shrink-0 flex items-center justify-between">
                                <span>Live Preview</span>
                                <span className="text-[10px] font-normal normal-case">Shows resolved merge fields</span>
                            </div>
                            {renderPreview(blankBody)}
                        </div>
                    </div>
                </div>
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
                            <p className="text-xs text-slate-400">{leadName} · {clientName}</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-3">
                        <div className="flex items-center gap-2">
                            <button className="p-1.5 text-slate-400 hover:text-slate-600 transition rounded hover:bg-slate-100" title="Preview">
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                            </button>
                        </div>
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${statusColors[editingContract.status] || statusColors.Draft}`}>
                            {editingContract.status}
                        </span>
                        {(editingContract.status === "Draft" || editingContract.status === "Sent") && (
                            <button
                                onClick={() => handleSend(editingContract.id)}
                                className="px-4 py-1.5 text-sm font-medium text-white bg-green-600 hover:bg-green-700 rounded-lg transition shadow-sm"
                            >
                                Send
                            </button>
                        )}
                        <button onClick={() => setEditingContract(null)} className="px-3 py-1.5 text-sm text-slate-500 hover:text-slate-700 border border-slate-200 rounded-lg transition">Cancel</button>
                        <button onClick={handleSaveEdit} disabled={saving} className="px-4 py-1.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition shadow-sm disabled:opacity-50">
                            {saving ? "Saving..." : "Save Changes"}
                        </button>
                    </div>
                </header>

                {renderToolbar(textareaRef, editBody, setEditBody, editUndoStack, editRedoStack, editHelpers)}

                <div className="flex-1 flex flex-col overflow-hidden">
                    <div className="lg:hidden flex border-b border-slate-200 shrink-0">
                        <button onClick={() => setActiveTab("edit")} className={`flex-1 py-2 text-sm font-medium text-center transition ${activeTab === "edit" ? "bg-white border-b-2 border-blue-500 text-blue-600" : "bg-slate-50 text-slate-500"}`}>✏️ Editor</button>
                        <button onClick={() => setActiveTab("preview")} className={`flex-1 py-2 text-sm font-medium text-center transition ${activeTab === "preview" ? "bg-white border-b-2 border-blue-500 text-blue-600" : "bg-slate-50 text-slate-500"}`}>👁️ Preview</button>
                    </div>
                    <div className="flex-1 flex overflow-hidden">
                        <div className={`flex-1 flex flex-col border-r border-slate-200 ${activeTab === "preview" ? "hidden lg:flex" : ""}`}>
                            <div className="px-4 py-2 bg-slate-50 text-xs font-semibold text-slate-500 uppercase tracking-wider border-b border-slate-200 shrink-0">
                                HTML Source
                            </div>
                            <textarea
                                ref={textareaRef}
                                className="flex-1 w-full p-4 font-mono text-sm text-slate-800 bg-white resize-none outline-none border-none leading-relaxed"
                                placeholder={"Edit your contract content here...\n\nUse Insert dropdowns above to add merge fields.\nCtrl+Z to undo, Ctrl+Shift+Z to redo."}
                                value={editBody}
                                onChange={e => handleEditBodyChange(e.target.value)}
                                onKeyDown={e => {
                                    if ((e.ctrlKey || e.metaKey) && e.key === "z") {
                                        e.preventDefault();
                                        if (e.shiftKey) editHelpers.handleRedo(); else editHelpers.handleUndo();
                                    }
                                }}
                                spellCheck={false}
                            />
                        </div>
                        <div className={`flex-1 flex flex-col bg-slate-100 ${activeTab === "edit" ? "hidden lg:flex" : ""}`}>
                            <div className="px-4 py-2 bg-slate-50 text-xs font-semibold text-slate-500 uppercase tracking-wider border-b border-slate-200 shrink-0 flex items-center justify-between">
                                <span>Live Preview</span>
                                <span className="text-[10px] font-normal normal-case">Shows resolved merge fields</span>
                            </div>
                            {renderPreview(editBody)}
                        </div>
                    </div>
                </div>
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
                    <div className="flex items-center gap-3">
                        <button onClick={() => router.push(`/leads/${leadId}`)} className="text-slate-400 hover:text-slate-600 transition">
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                        </button>
                        <div>
                            <h1 className="text-xl font-bold text-hui-textMain">Contracts</h1>
                            <p className="text-sm text-hui-textMuted">{leadName} · {clientName}</p>
                        </div>
                    </div>
                    <div className="relative">
                        <button
                            onClick={() => setShowCreateMenu(!showCreateMenu)}
                            className="hui-btn hui-btn-primary flex items-center gap-2"
                        >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                            Contract
                            <svg className="w-3 h-3 ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 9l6 6 6-6" /></svg>
                        </button>

                        {/* Create Dropdown */}
                        {showCreateMenu && (
                            <div className="absolute right-0 mt-2 w-56 bg-white border border-slate-200 rounded-xl shadow-xl overflow-hidden z-30">
                                <button
                                    onClick={handleCreateBlank}
                                    className="w-full flex items-center gap-3 px-4 py-3 text-sm text-slate-700 hover:bg-slate-50 transition text-left"
                                >
                                    <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                                    From scratch
                                </button>
                                <button
                                    onClick={() => { setShowCreateMenu(false); toast.info("Import contract coming soon"); }}
                                    className="w-full flex items-center gap-3 px-4 py-3 text-sm text-slate-700 hover:bg-slate-50 transition text-left border-t border-slate-100"
                                >
                                    <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
                                    Import Contract
                                </button>
                                <button
                                    onClick={() => { setShowCreateMenu(false); setShowTemplateModal(true); }}
                                    className="w-full flex items-center gap-3 px-4 py-3 text-sm text-slate-700 hover:bg-slate-50 transition text-left border-t border-slate-100"
                                >
                                    <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7v8a2 2 0 002 2h6M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2M8 7H6a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2v-2" /></svg>
                                    From template
                                </button>
                            </div>
                        )}
                    </div>
                </div>

                {/* Contract List */}
                {initialContracts.length === 0 ? (
                    <div className="text-center py-20 bg-white border border-slate-200 rounded-xl shadow-sm">
                        <svg className="w-14 h-14 text-slate-200 mx-auto mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                        <p className="text-slate-500 font-medium text-lg mb-1">No contracts yet</p>
                        <p className="text-sm text-slate-400 mb-6">Create a contract from scratch or from a template to get started.</p>
                        <button
                            onClick={() => setShowCreateMenu(true)}
                            className="hui-btn hui-btn-primary text-sm"
                        >
                            + Create Contract
                        </button>
                    </div>
                ) : (
                    <div className="space-y-3">
                        {initialContracts.map((c: any) => (
                            <div key={c.id} className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 hover:shadow-md transition group">
                                <div className="flex items-start justify-between">
                                    <div className="min-w-0 cursor-pointer flex-1" onClick={() => openEditor(c)}>
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
            </div>

            {/* ── TEMPLATE CHOOSER MODAL ── */}
            {showTemplateModal && (
                <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setShowTemplateModal(false)}>
                    <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full max-h-[80vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
                        {/* Header */}
                        <div className="px-6 pt-6 pb-4 border-b border-slate-200 flex items-center justify-between">
                            <h2 className="text-xl font-bold text-slate-800">Choose Template</h2>
                            <button onClick={() => setShowTemplateModal(false)} className="text-slate-400 hover:text-slate-600 transition text-xl leading-none">×</button>
                        </div>

                        {/* Search + Manage */}
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

                        {/* Template List */}
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
                                            onClick={() => {
                                                handleTemplateChange(t.id);
                                                setSelectedTemplate(t.id);
                                            }}
                                            className={`w-full text-left px-6 py-4 hover:bg-slate-50 transition flex items-center justify-between ${
                                                selectedTemplate === t.id ? "bg-green-50 border-l-4 border-green-500" : ""
                                            }`}
                                        >
                                            <div>
                                                <p className="text-sm font-medium text-slate-800 uppercase tracking-wide">{t.name}</p>
                                                <p className="text-xs text-slate-400 mt-0.5">
                                                    {t.type === "lien_release" ? "Lien Release" : "Contract"}
                                                </p>
                                            </div>
                                            {selectedTemplate === t.id && (
                                                <svg className="w-5 h-5 text-green-600 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
                                            )}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>

                        {/* Recurring Toggle + Actions */}
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

            {/* Click-away to close create menu */}
            {showCreateMenu && <div className="fixed inset-0 z-20" onClick={() => setShowCreateMenu(false)} />}
        </div>
    );
}
