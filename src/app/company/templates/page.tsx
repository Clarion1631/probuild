"use client";
export const dynamic = "force-dynamic";

import { useState, useEffect, useRef } from "react";
import { getDocumentTemplates, createDocumentTemplate, updateDocumentTemplate, deleteDocumentTemplate, getCompanySettings } from "@/lib/actions";
import { toast } from "sonner";

type Template = {
    id: string;
    name: string;
    type: string;
    body: string;
    isDefault: boolean;
    updatedAt: Date;
};

type CompanySettings = {
    companyName: string;
    address?: string | null;
    phone?: string | null;
    email?: string | null;
    website?: string | null;
    logoUrl?: string | null;
};

const MERGE_FIELDS = [
    {
        category: "Client",
        icon: "👤",
        color: "blue",
        fields: [
            { key: "client_name", label: "Name", example: "John Doe" },
            { key: "client_email", label: "Email", example: "john@example.com" },
            { key: "client_phone", label: "Phone", example: "(555) 123-4567" },
            { key: "client_address", label: "Address", example: "123 Main St, Los Angeles, CA 90001" },
        ]
    },
    {
        category: "Company",
        icon: "🏢",
        color: "purple",
        fields: [
            { key: "company_name", label: "Name", example: "Golden Touch Remodeling" },
            { key: "company_address", label: "Address", example: "456 Business Ave" },
            { key: "company_phone", label: "Phone", example: "(555) 987-6543" },
            { key: "company_email", label: "Email", example: "info@company.com" },
        ]
    },
    {
        category: "Project",
        icon: "📋",
        color: "green",
        fields: [
            { key: "project_name", label: "Name", example: "Kitchen Remodel" },
            { key: "location", label: "Location", example: "123 Main St, Los Angeles" },
            { key: "estimate_total", label: "Estimate Total", example: "$45,000" },
        ]
    },
    {
        category: "Date",
        icon: "📅",
        color: "amber",
        fields: [
            { key: "date", label: "Today's Date", example: "March 10, 2026" },
            { key: "year", label: "Year", example: "2026" },
        ]
    }
];

const categoryColors: Record<string, { bg: string; text: string; border: string; pill: string }> = {
    blue: { bg: "bg-blue-50", text: "text-blue-700", border: "border-blue-200", pill: "bg-blue-100 text-blue-700 hover:bg-blue-200" },
    purple: { bg: "bg-purple-50", text: "text-purple-700", border: "border-purple-200", pill: "bg-purple-100 text-purple-700 hover:bg-purple-200" },
    green: { bg: "bg-green-50", text: "text-green-700", border: "border-green-200", pill: "bg-green-100 text-green-700 hover:bg-green-200" },
    amber: { bg: "bg-amber-50", text: "text-amber-700", border: "border-amber-200", pill: "bg-amber-100 text-amber-700 hover:bg-amber-200" },
};

function resolvePreview(html: string, company: CompanySettings): string {
    const data: Record<string, string> = {};
    MERGE_FIELDS.forEach(cat => cat.fields.forEach(f => { data[f.key] = f.example; }));
    // Override with real company data
    if (company.companyName) data.company_name = company.companyName;
    if (company.address) data.company_address = company.address;
    if (company.phone) data.company_phone = company.phone;
    if (company.email) data.company_email = company.email;
    data.date = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    data.year = new Date().getFullYear().toString();

    return html.replace(/\{\{(\w+)\}\}/g, (match, key) => {
        const value = data[key];
        if (value) return `<span style="background: #dbeafe; padding: 1px 4px; border-radius: 4px; font-weight: 600;">${value}</span>`;
        return `<span style="background: #fef3c7; padding: 1px 4px; border-radius: 4px; color: #92400e;">${match}</span>`;
    });
}

export default function TemplatesPage() {
    const [templates, setTemplates] = useState<Template[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [showEditor, setShowEditor] = useState(false);
    const [editingTemplate, setEditingTemplate] = useState<Template | null>(null);
    const [company, setCompany] = useState<CompanySettings>({ companyName: "Your Company" });
    const [activeTab, setActiveTab] = useState<"edit" | "preview">("edit");
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    const [form, setForm] = useState({ name: "", type: "terms", body: "", isDefault: false });

    useEffect(() => {
        loadTemplates();
        loadCompany();
    }, []);

    async function loadTemplates() {
        setLoading(true);
        setLoadError(null);
        try {
            const data = await getDocumentTemplates();
            setTemplates(data as Template[]);
        } catch (e: any) {
            console.error("Failed to load templates:", e);
            setLoadError(e?.message || "Failed to load templates. Please try again.");
        } finally {
            setLoading(false);
        }
    }

    async function loadCompany() {
        try {
            const data = await getCompanySettings();
            setCompany(data as CompanySettings);
        } catch (e) {
            console.error("Failed to load company settings:", e);
        }
    }

    function openCreate() {
        setEditingTemplate(null);
        setForm({ name: "", type: "terms", body: "", isDefault: false });
        setShowEditor(true);
        setActiveTab("edit");
    }

    function openEdit(t: Template) {
        setEditingTemplate(t);
        setForm({ name: t.name, type: t.type, body: t.body, isDefault: t.isDefault });
        setShowEditor(true);
        setActiveTab("edit");
    }

    function insertMergeField(key: string) {
        const ta = textareaRef.current;
        if (!ta) {
            setForm(prev => ({ ...prev, body: prev.body + `{{${key}}}` }));
            return;
        }
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        const text = form.body;
        const before = text.substring(0, start);
        const after = text.substring(end);
        const newBody = before + `{{${key}}}` + after;
        setForm(prev => ({ ...prev, body: newBody }));
        setTimeout(() => {
            ta.focus();
            const pos = start + `{{${key}}}`.length;
            ta.setSelectionRange(pos, pos);
        }, 0);
    }

    function insertHtmlTag(tag: string, wrap?: string) {
        const ta = textareaRef.current;
        if (!ta) return;
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        const selected = form.body.substring(start, end);
        const text = form.body;
        
        const openTag = `<${tag}>`;
        const closeTag = `</${tag}>`;
        
        const beforeSelection = text.substring(0, start);
        const afterSelection = text.substring(end);
        
        // Toggle off if currently wrapped exactly by this tag
        if (beforeSelection.endsWith(openTag) && afterSelection.startsWith(closeTag)) {
            const newBody = text.substring(0, start - openTag.length) + selected + text.substring(end + closeTag.length);
            setForm(prev => ({ ...prev, body: newBody }));
            setTimeout(() => { 
                ta.focus(); 
                ta.setSelectionRange(start - openTag.length, end - openTag.length);
            }, 0);
            return;
        }

        let insert: string;
        if (wrap) {
            insert = `${openTag}${selected || wrap}${closeTag}`;
        } else {
            insert = `${openTag}`;
        }
        const newBody = text.substring(0, start) + insert + text.substring(end);
        setForm(prev => ({ ...prev, body: newBody }));
        setTimeout(() => { ta.focus(); }, 0);
    }

    async function handleSave() {
        if (!form.name.trim() || !form.body.trim()) {
            toast.error("Name and content are required");
            return;
        }
        try {
            if (editingTemplate) {
                await updateDocumentTemplate(editingTemplate.id, form);
                toast.success("Template updated");
            } else {
                await createDocumentTemplate(form);
                toast.success("Template created");
            }
            setShowEditor(false);
            loadTemplates();
        } catch {
            toast.error("Failed to save template");
        }
    }

    async function handleDelete(id: string) {
        if (!confirm("Delete this template?")) return;
        try {
            await deleteDocumentTemplate(id);
            toast.success("Template deleted");
            loadTemplates();
        } catch {
            toast.error("Failed to delete template");
        }
    }

    async function handleSetDefault(t: Template) {
        try {
            await updateDocumentTemplate(t.id, { isDefault: !t.isDefault });
            toast.success(t.isDefault ? "Default removed" : "Set as default");
            loadTemplates();
        } catch {
            toast.error("Failed to update template");
        }
    }

    const typeColors: Record<string, string> = {
        terms: "bg-blue-50 text-blue-700 border-blue-200",
        contract: "bg-purple-50 text-purple-700 border-purple-200",
        disclaimer: "bg-amber-50 text-amber-700 border-amber-200",
        lien_release: "bg-rose-50 text-rose-700 border-rose-200",
    };
    const typeLabels: Record<string, string> = {
        terms: "Terms & Conditions",
        contract: "Contract",
        disclaimer: "Disclaimer",
        lien_release: "Lien Release",
    };

    // ─── FULL-SCREEN EDITOR ───
    if (showEditor) {
        return (
            <div className="font-sans text-slate-900 h-full flex flex-col bg-white">
                {/* Editor Header */}
                <header className="bg-white border-b border-hui-border px-6 py-3 flex items-center justify-between shrink-0">
                    <div className="flex items-center gap-3">
                        <button onClick={() => setShowEditor(false)} className="text-hui-textMuted hover:text-hui-textMain transition p-1">
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                        </button>
                        <div>
                            <input
                                type="text"
                                value={form.name}
                                onChange={e => setForm({ ...form, name: e.target.value })}
                                placeholder="Template Name"
                                className="text-lg font-bold text-hui-textMain bg-transparent border-none outline-none w-80 placeholder:text-slate-300"
                            />
                        </div>
                    </div>
                    <div className="flex items-center gap-3">
                        <select
                            className="hui-input text-sm py-1.5"
                            value={form.type}
                            onChange={e => setForm({ ...form, type: e.target.value })}
                        >
                            <option value="terms">Terms & Conditions</option>
                            <option value="contract">Contract</option>
                            <option value="lien_release">Lien Release</option>
                            <option value="disclaimer">Disclaimer</option>
                        </select>
                        <label className="flex items-center gap-1.5 text-sm text-hui-textMuted cursor-pointer">
                            <input
                                type="checkbox"
                                checked={form.isDefault}
                                onChange={e => setForm({ ...form, isDefault: e.target.checked })}
                                className="w-4 h-4 rounded border-slate-300"
                            />
                            Default
                        </label>
                        <button onClick={() => setShowEditor(false)} className="hui-btn hui-btn-secondary text-sm">Cancel</button>
                        <button onClick={handleSave} className="hui-btn hui-btn-primary text-sm">
                            {editingTemplate ? "Update" : "Create"}
                        </button>
                    </div>
                </header>

                {/* Merge Field Toolbar */}
                <div className="bg-slate-50 border-b border-hui-border px-6 py-3 shrink-0">
                    <div className="flex items-start gap-4 flex-wrap">
                        <span className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider pt-1.5 shrink-0">Insert Field:</span>
                        {MERGE_FIELDS.map(cat => (
                            <div key={cat.category} className="flex items-center gap-1.5">
                                <span className="text-xs font-semibold text-hui-textMuted">{cat.icon} {cat.category}:</span>
                                <div className="flex gap-1 flex-wrap">
                                    {cat.fields.map(f => (
                                        <button
                                            key={f.key}
                                            onClick={() => insertMergeField(f.key)}
                                            className={`px-2 py-0.5 rounded-full text-xs font-medium transition cursor-pointer ${categoryColors[cat.color].pill}`}
                                            title={`Inserts {{${f.key}}} → "${f.example}"`}
                                        >
                                            {f.label}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                {/* HTML Format Toolbar */}
                <div className="bg-white border-b border-hui-border px-6 py-2 shrink-0 flex items-center gap-1">
                    <span className="text-xs font-semibold text-hui-textMuted mr-2">Format:</span>
                    <button onClick={() => insertHtmlTag("h2", "Heading")} className="px-2 py-1 text-xs rounded hover:bg-slate-100 font-bold transition" title="Heading 2">H2</button>
                    <button onClick={() => insertHtmlTag("h3", "Subheading")} className="px-2 py-1 text-xs rounded hover:bg-slate-100 font-semibold transition" title="Heading 3">H3</button>
                    <button onClick={() => insertHtmlTag("strong", "bold text")} className="px-2 py-1 text-xs rounded hover:bg-slate-100 font-bold transition" title="Bold"><b>B</b></button>
                    <button onClick={() => insertHtmlTag("em", "italic text")} className="px-2 py-1 text-xs rounded hover:bg-slate-100 italic transition" title="Italic"><em>I</em></button>
                    <button onClick={() => insertHtmlTag("p", "Paragraph text")} className="px-2 py-1 text-xs rounded hover:bg-slate-100 transition" title="Paragraph">¶</button>
                    <button onClick={() => insertHtmlTag("ul")} className="px-2 py-1 text-xs rounded hover:bg-slate-100 transition" title="Unordered List">• List</button>
                    <button onClick={() => insertHtmlTag("li", "List item")} className="px-2 py-1 text-xs rounded hover:bg-slate-100 transition" title="List Item">— Item</button>
                    <div className="w-px h-5 bg-slate-200 mx-1"></div>
                    <button onClick={() => insertHtmlTag("hr")} className="px-2 py-1 text-xs rounded hover:bg-slate-100 transition" title="Horizontal Rule">― Line</button>
                    <button onClick={() => insertHtmlTag("br")} className="px-2 py-1 text-xs rounded hover:bg-slate-100 transition" title="Line Break">↵ Break</button>
                </div>

                {/* Tab Switcher (mobile) + Split Pane (desktop) */}
                <div className="flex-1 flex flex-col overflow-hidden">
                    {/* Mobile Tab Switcher */}
                    <div className="lg:hidden flex border-b border-hui-border shrink-0">
                        <button onClick={() => setActiveTab("edit")} className={`flex-1 py-2 text-sm font-medium text-center transition ${activeTab === "edit" ? "bg-white border-b-2 border-blue-500 text-blue-600" : "bg-slate-50 text-hui-textMuted"}`}>
                            ✏️ Editor
                        </button>
                        <button onClick={() => setActiveTab("preview")} className={`flex-1 py-2 text-sm font-medium text-center transition ${activeTab === "preview" ? "bg-white border-b-2 border-blue-500 text-blue-600" : "bg-slate-50 text-hui-textMuted"}`}>
                            👁️ Preview
                        </button>
                    </div>

                    <div className="flex-1 flex overflow-hidden">
                        {/* Editor Pane */}
                        <div className={`flex-1 flex flex-col border-r border-hui-border ${activeTab === "preview" ? "hidden lg:flex" : ""}`}>
                            <div className="px-4 py-2 bg-slate-50 text-xs font-semibold text-hui-textMuted uppercase tracking-wider border-b border-hui-border shrink-0">
                                HTML Source
                            </div>
                            <textarea
                                ref={textareaRef}
                                className="flex-1 w-full p-4 font-mono text-sm text-slate-800 bg-white resize-none outline-none border-none leading-relaxed"
                                placeholder="Start typing your template content here...&#10;&#10;Use the merge field buttons above to insert dynamic values like {{client_name}}.&#10;Use the format buttons to add HTML structure."
                                value={form.body}
                                onChange={e => setForm({ ...form, body: e.target.value })}
                                spellCheck={false}
                            />
                        </div>

                        {/* Preview Pane */}
                        <div className={`flex-1 flex flex-col bg-slate-100 ${activeTab === "edit" ? "hidden lg:flex" : ""}`}>
                            <div className="px-4 py-2 bg-slate-50 text-xs font-semibold text-hui-textMuted uppercase tracking-wider border-b border-hui-border shrink-0 flex items-center justify-between">
                                <span>Live Preview</span>
                                <span className="text-[10px] font-normal normal-case">Merge fields shown with sample data</span>
                            </div>
                            <div className="flex-1 overflow-auto p-6">
                                <div className="bg-white rounded-xl shadow-lg border border-slate-200 max-w-2xl mx-auto overflow-hidden">
                                    {/* Document Header with Logo */}
                                    <div className="bg-gradient-to-r from-slate-800 to-slate-700 px-8 py-6 text-white">
                                        <div className="flex items-center gap-4">
                                            {company.logoUrl ? (
                                                <img src={company.logoUrl} alt="Logo" className="h-12 w-auto object-contain rounded bg-white p-1" />
                                            ) : (
                                                <div className="w-12 h-12 bg-white/20 rounded-lg flex items-center justify-center text-xl font-bold">
                                                    {company.companyName?.charAt(0) || "C"}
                                                </div>
                                            )}
                                            <div>
                                                <h1 className="text-lg font-bold">{company.companyName || "Your Company"}</h1>
                                                {company.phone && <p className="text-sm text-slate-300">{company.phone}</p>}
                                            </div>
                                        </div>
                                    </div>

                                    {/* Document Body */}
                                    <div className="p-8">
                                        {form.body ? (
                                            <div
                                                className="prose prose-sm max-w-none prose-headings:text-slate-800 prose-headings:font-semibold prose-p:text-slate-600 prose-p:leading-relaxed prose-strong:text-slate-800 prose-li:text-slate-600"
                                                dangerouslySetInnerHTML={{ __html: resolvePreview(form.body, company) }}
                                            />
                                        ) : (
                                            <div className="text-center py-16 text-slate-400">
                                                <svg className="w-12 h-12 mx-auto mb-3 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                                                <p className="text-sm">Start typing in the editor to see a live preview</p>
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

    // ─── TEMPLATES LIST ───
    return (
        <div className="font-sans text-slate-900 h-full flex flex-col">
            <header className="bg-white border-b border-hui-border px-8 py-4 flex items-center justify-between sticky top-0 z-10">
                <div>
                    <h1 className="text-xl font-bold text-hui-textMain">Document Templates</h1>
                    <p className="text-sm text-hui-textMuted mt-0.5">Manage terms & conditions, contracts, and disclaimers</p>
                </div>
                <button onClick={openCreate} className="hui-btn hui-btn-primary">
                    + Add Template
                </button>
            </header>

            <div className="p-8 flex-1 overflow-y-auto w-full max-w-5xl mx-auto bg-hui-background">
                {loading ? (
                    <div className="text-center py-20 text-hui-textMuted">
                        <div className="w-8 h-8 border-2 border-slate-300 border-t-blue-500 rounded-full animate-spin mx-auto mb-4"></div>
                        Loading templates...
                    </div>
                ) : loadError ? (
                    <div className="text-center py-20 flex flex-col items-center">
                        <div className="w-16 h-16 bg-red-50 rounded-full flex items-center justify-center mb-4">
                            <svg className="w-8 h-8 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" /></svg>
                        </div>
                        <h3 className="text-lg font-medium text-slate-900 mb-1">Failed to load templates</h3>
                        <p className="text-slate-500 mb-4 text-sm">{loadError}</p>
                        <button onClick={loadTemplates} className="hui-btn hui-btn-primary">Retry</button>
                    </div>
                ) : templates.length === 0 ? (
                    <div className="text-center py-20 flex flex-col items-center">
                        <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mb-4">
                            <svg className="w-8 h-8 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                        </div>
                        <h3 className="text-lg font-medium text-slate-900 mb-1">No templates yet</h3>
                        <p className="text-slate-500 mb-6">Create your first template to attach to estimates and contracts.</p>
                        <button onClick={openCreate} className="hui-btn hui-btn-primary">+ Add Template</button>
                    </div>
                ) : (
                    <div className="space-y-3">
                        {templates.map(t => (
                            <div key={t.id} className="hui-card p-5 hover:shadow-md transition-shadow group">
                                <div className="flex items-start justify-between gap-4">
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-3 mb-2">
                                            <h3 className="font-semibold text-hui-textMain text-base">{t.name}</h3>
                                            <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border ${typeColors[t.type] || typeColors.terms}`}>
                                                {typeLabels[t.type] || t.type}
                                            </span>
                                            {t.isDefault && (
                                                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-50 text-green-700 border border-green-200">
                                                    ✓ Default
                                                </span>
                                            )}
                                        </div>
                                        <p className="text-sm text-hui-textMuted line-clamp-2">{t.body.replace(/<[^>]*>/g, '').slice(0, 150)}...</p>
                                        <p className="text-xs text-hui-textMuted mt-2">Last updated: {new Date(t.updatedAt).toLocaleDateString()}</p>
                                    </div>
                                    <div className="flex items-center gap-2 shrink-0 opacity-0 group-hover:opacity-100 transition">
                                        <button onClick={() => handleSetDefault(t)} className={`px-3 py-1.5 text-xs font-medium rounded-md transition ${t.isDefault ? "bg-green-100 text-green-700 hover:bg-green-200" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}>
                                            {t.isDefault ? "Remove Default" : "Set Default"}
                                        </button>
                                        <button onClick={() => openEdit(t)} className="px-3 py-1.5 text-xs font-medium rounded-md bg-blue-50 text-blue-700 hover:bg-blue-100 transition">
                                            Edit
                                        </button>
                                        <button onClick={() => handleDelete(t.id)} className="px-3 py-1.5 text-xs font-medium rounded-md bg-red-50 text-red-600 hover:bg-red-100 transition">
                                            Delete
                                        </button>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

