"use client";

import { useState, useEffect } from "react";
import { getDocumentTemplates, createDocumentTemplate, updateDocumentTemplate, deleteDocumentTemplate } from "@/lib/actions";
import { toast } from "sonner";

type Template = {
    id: string;
    name: string;
    type: string;
    body: string;
    isDefault: boolean;
    updatedAt: Date;
};

export default function TemplatesPage() {
    const [templates, setTemplates] = useState<Template[]>([]);
    const [loading, setLoading] = useState(true);
    const [showModal, setShowModal] = useState(false);
    const [editingTemplate, setEditingTemplate] = useState<Template | null>(null);

    const [form, setForm] = useState({ name: "", type: "terms", body: "", isDefault: false });

    useEffect(() => {
        loadTemplates();
    }, []);

    async function loadTemplates() {
        const data = await getDocumentTemplates();
        setTemplates(data as Template[]);
        setLoading(false);
    }

    function openCreate() {
        setEditingTemplate(null);
        setForm({ name: "", type: "terms", body: "", isDefault: false });
        setShowModal(true);
    }

    function openEdit(t: Template) {
        setEditingTemplate(t);
        setForm({ name: t.name, type: t.type, body: t.body, isDefault: t.isDefault });
        setShowModal(true);
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
            setShowModal(false);
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
    };

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
                    <div className="text-center py-20 text-hui-textMuted">Loading templates...</div>
                ) : templates.length === 0 ? (
                    <div className="text-center py-20 flex flex-col items-center">
                        <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mb-4">
                            <svg className="w-8 h-8 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                        </div>
                        <h3 className="text-lg font-medium text-slate-900 mb-1">No templates yet</h3>
                        <p className="text-slate-500 mb-6">Create your first terms & conditions template to attach to estimates.</p>
                        <button onClick={openCreate} className="hui-btn hui-btn-primary">+ Add Template</button>
                    </div>
                ) : (
                    <div className="hui-card overflow-hidden">
                        <table className="w-full text-left border-collapse">
                            <thead>
                                <tr className="bg-slate-50 border-b border-hui-border text-sm font-semibold text-hui-textMuted whitespace-nowrap">
                                    <th className="px-6 py-4 font-normal">Name</th>
                                    <th className="px-6 py-4 font-normal">Type</th>
                                    <th className="px-6 py-4 font-normal">Default</th>
                                    <th className="px-6 py-4 font-normal">Last Updated</th>
                                    <th className="px-6 py-4 font-normal text-right">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-hui-border text-sm">
                                {templates.map(t => (
                                    <tr key={t.id} className="hover:bg-slate-50 transition-colors group">
                                        <td className="px-6 py-4">
                                            <div className="font-medium text-hui-textMain">{t.name}</div>
                                            <div className="text-xs text-hui-textMuted mt-0.5 line-clamp-1 max-w-sm">{t.body.replace(/<[^>]*>/g, '').slice(0, 80)}...</div>
                                        </td>
                                        <td className="px-6 py-4">
                                            <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold border capitalize ${typeColors[t.type] || typeColors.terms}`}>
                                                {t.type}
                                            </span>
                                        </td>
                                        <td className="px-6 py-4">
                                            <button
                                                onClick={() => handleSetDefault(t)}
                                                className={`w-5 h-5 rounded border-2 flex items-center justify-center transition ${t.isDefault ? 'bg-green-500 border-green-500 text-white' : 'border-slate-300 hover:border-slate-400'}`}
                                            >
                                                {t.isDefault && (
                                                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
                                                )}
                                            </button>
                                        </td>
                                        <td className="px-6 py-4 text-hui-textMuted">
                                            {new Date(t.updatedAt).toLocaleDateString()}
                                        </td>
                                        <td className="px-6 py-4 text-right">
                                            <div className="flex justify-end gap-2 opacity-0 group-hover:opacity-100 transition">
                                                <button onClick={() => openEdit(t)} className="text-blue-600 hover:text-blue-800 font-medium text-sm">Edit</button>
                                                <button onClick={() => handleDelete(t.id)} className="text-red-500 hover:text-red-700 font-medium text-sm">Delete</button>
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {/* Create / Edit Modal */}
            {showModal && (
                <div className="fixed inset-0 bg-slate-900/50 flex items-center justify-center z-50 p-4">
                    <div className="bg-white rounded-xl shadow-xl max-w-2xl w-full overflow-hidden border border-hui-border max-h-[90vh] flex flex-col">
                        <div className="px-6 py-4 border-b border-hui-border flex justify-between items-center shrink-0">
                            <h2 className="text-lg font-bold text-hui-textMain">
                                {editingTemplate ? "Edit Template" : "Create Template"}
                            </h2>
                            <button onClick={() => setShowModal(false)} className="text-hui-textMuted hover:text-hui-textMain transition">
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                            </button>
                        </div>
                        <div className="p-6 space-y-5 overflow-y-auto flex-1">
                            <div>
                                <label className="block text-sm font-medium text-hui-textMain mb-1">Template Name</label>
                                <input
                                    type="text"
                                    className="hui-input w-full"
                                    placeholder="e.g. Standard Terms & Conditions"
                                    value={form.name}
                                    onChange={e => setForm({ ...form, name: e.target.value })}
                                />
                            </div>
                            <div className="flex gap-4">
                                <div className="flex-1">
                                    <label className="block text-sm font-medium text-hui-textMain mb-1">Type</label>
                                    <select
                                        className="hui-input w-full"
                                        value={form.type}
                                        onChange={e => setForm({ ...form, type: e.target.value })}
                                    >
                                        <option value="terms">Terms & Conditions</option>
                                        <option value="contract">Contract</option>
                                        <option value="disclaimer">Disclaimer</option>
                                    </select>
                                </div>
                                <div className="flex items-end pb-1">
                                    <label className="flex items-center gap-2 text-sm text-hui-textMain cursor-pointer">
                                        <input
                                            type="checkbox"
                                            checked={form.isDefault}
                                            onChange={e => setForm({ ...form, isDefault: e.target.checked })}
                                            className="w-4 h-4 rounded border-slate-300"
                                        />
                                        Set as default
                                    </label>
                                </div>
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-hui-textMain mb-1">Content</label>
                                <textarea
                                    className="hui-input w-full min-h-[250px] font-mono text-sm"
                                    placeholder="Enter your terms and conditions content here. You can use basic HTML for formatting."
                                    value={form.body}
                                    onChange={e => setForm({ ...form, body: e.target.value })}
                                />
                                <p className="text-xs text-hui-textMuted mt-1">Tip: You can use HTML tags for formatting (e.g. &lt;h3&gt;, &lt;p&gt;, &lt;ul&gt;, &lt;strong&gt;)</p>
                            </div>
                        </div>
                        <div className="px-6 py-4 border-t border-hui-border flex justify-end gap-3 shrink-0 bg-slate-50">
                            <button onClick={() => setShowModal(false)} className="hui-btn hui-btn-secondary">Cancel</button>
                            <button onClick={handleSave} className="hui-btn hui-btn-primary">
                                {editingTemplate ? "Update Template" : "Create Template"}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
