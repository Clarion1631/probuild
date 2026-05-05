"use client";

import { useState, useEffect } from "react";
import { getDocumentTemplates, createDocumentTemplate, updateDocumentTemplate, deleteDocumentTemplate } from "@/lib/actions";
import { toast } from "sonner";
import { MERGE_FIELD_CATEGORIES } from "@/lib/merge-fields";
import { MergeFieldEditor } from "./MergeFieldEditor";

type Template = {
    id: string;
    name: string;
    type: string;
    body: string;
    isDefault: boolean;
    updatedAt: Date;
};

type Props = {
    allowedType?: string;
    showTypeSelector?: boolean;
    title: string;
    description: string;
};

const templateMergeFields = MERGE_FIELD_CATEGORIES.filter(c => c.category !== "Signing");

const typeColors: Record<string, string> = {
    terms: "bg-blue-50 text-blue-700 border-blue-200",
    contract: "bg-purple-50 text-purple-700 border-purple-200",
    disclaimer: "bg-amber-50 text-amber-700 border-amber-200",
    lien_release: "bg-rose-50 text-rose-700 border-rose-200",
    change_order: "bg-orange-50 text-orange-700 border-orange-200",
    draw_request: "bg-emerald-50 text-emerald-700 border-emerald-200",
    warranty: "bg-teal-50 text-teal-700 border-teal-200",
    punch_list: "bg-slate-100 text-slate-700 border-slate-300",
    addendum: "bg-indigo-50 text-indigo-700 border-indigo-200",
};

const typeLabels: Record<string, string> = {
    terms: "Terms & Conditions",
    contract: "Contract",
    disclaimer: "Disclaimer",
    lien_release: "Lien Release",
    change_order: "Change Order",
    draw_request: "Draw Request",
    warranty: "Warranty",
    punch_list: "Punch List",
    addendum: "Addendum",
};

export default function DocumentTemplateManager({ allowedType, showTypeSelector = true, title, description }: Props) {
    const defaultType = allowedType ?? "terms";

    const [templates, setTemplates] = useState<Template[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [showEditor, setShowEditor] = useState(false);
    const [editingTemplate, setEditingTemplate] = useState<Template | null>(null);

    const [form, setForm] = useState({ name: "", type: defaultType, body: "", isDefault: false });

    useEffect(() => {
        loadTemplates();
    }, []);

    async function loadTemplates() {
        setLoading(true);
        setLoadError(null);
        try {
            const data = await getDocumentTemplates(allowedType);
            setTemplates(data as Template[]);
        } catch (e: any) {
            console.error("Failed to load templates:", e);
            setLoadError(e?.message || "Failed to load templates. Please try again.");
        } finally {
            setLoading(false);
        }
    }

    function openCreate() {
        setEditingTemplate(null);
        setForm({ name: "", type: defaultType, body: "", isDefault: false });
        setShowEditor(true);
    }

    function openEdit(t: Template) {
        // Warn if the template has inline styles/attributes that Tiptap will normalize on save
        if (t.body && /style\s*=\s*"/i.test(t.body)) {
            toast.info("This template has custom formatting that will be standardized by the editor. Review before saving.", { duration: 6000 });
        }
        setEditingTemplate(t);
        setForm({ name: t.name, type: t.type, body: t.body, isDefault: t.isDefault });
        setShowEditor(true);
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

    // ─── FULL-SCREEN EDITOR ───
    if (showEditor) {
        return (
            <div className="font-sans text-slate-900 h-full flex flex-col bg-white">
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
                        {showTypeSelector && (
                            <select
                                className="hui-input text-sm py-1.5"
                                value={form.type}
                                onChange={e => setForm({ ...form, type: e.target.value })}
                            >
                                <option value="terms">Terms & Conditions</option>
                                <option value="contract">Contract</option>
                                <option value="change_order">Change Order</option>
                                <option value="draw_request">Draw Request</option>
                                <option value="lien_release">Lien Release</option>
                                <option value="warranty">Warranty</option>
                                <option value="punch_list">Punch List</option>
                                <option value="addendum">Addendum</option>
                                <option value="disclaimer">Disclaimer</option>
                            </select>
                        )}
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

                {/* WYSIWYG Editor */}
                <div className="flex-1 flex flex-col overflow-hidden">
                    <MergeFieldEditor
                        value={form.body}
                        onChange={(html) => setForm(prev => ({ ...prev, body: html }))}
                        mergeFieldCategories={templateMergeFields}
                        signingSection={false}
                    />
                </div>
            </div>
        );
    }

    // ─── TEMPLATES LIST ───
    return (
        <div className="font-sans text-slate-900 h-full flex flex-col">
            <header className="bg-white border-b border-hui-border px-8 py-4 flex items-center justify-between sticky top-0 z-10">
                <div>
                    <h1 className="text-xl font-bold text-hui-textMain">{title}</h1>
                    <p className="text-sm text-hui-textMuted mt-0.5">{description}</p>
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
                                            {showTypeSelector && (
                                                <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border ${typeColors[t.type] || typeColors.terms}`}>
                                                    {typeLabels[t.type] || t.type}
                                                </span>
                                            )}
                                            {t.isDefault && (
                                                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-50 text-green-700 border border-green-200">
                                                    Default
                                                </span>
                                            )}
                                        </div>
                                        <p className="text-sm text-hui-textMuted line-clamp-2">{t.body.replace(/<[^>]*>/g, '').slice(0, 150)}...</p>
                                        <p className="text-xs text-hui-textMuted mt-2">Last updated: {new Date(t.updatedAt).toLocaleDateString()}</p>
                                    </div>
                                    <div className="flex items-center gap-2 shrink-0 opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto transition">
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
