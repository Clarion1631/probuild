"use client";
export const dynamic = "force-dynamic";

import { useState, useEffect } from "react";
import { toast } from "sonner";

type TemplateRow = {
    id: string;
    name: string;
    source: string; // "standard" | "custom"
    itemCount: number;
    phases: string[];
    createdAt: string;
    updatedAt: string;
    modified: boolean;
};

function fmtDate(iso: string) {
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export default function EstimateTemplatesPage() {
    const [templates, setTemplates] = useState<TemplateRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [expanded, setExpanded] = useState<string | null>(null);
    const [renaming, setRenaming] = useState<TemplateRow | null>(null);
    const [renameValue, setRenameValue] = useState("");

    useEffect(() => { void fetchTemplates(); }, []);

    async function fetchTemplates() {
        const res = await fetch("/api/estimate-templates");
        if (res.ok) setTemplates(await res.json());
        else toast.error("Failed to load templates");
        setLoading(false);
    }

    async function handleRename(e: React.FormEvent) {
        e.preventDefault();
        if (!renaming || !renameValue.trim()) return;
        const res = await fetch("/api/estimate-templates", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: renaming.id, name: renameValue.trim() }),
        });
        if (res.ok) {
            toast.success("Template renamed");
            setRenaming(null);
            void fetchTemplates();
        } else {
            const d = await res.json().catch(() => ({}));
            toast.error(d.error || "Rename failed");
        }
    }

    async function handleDelete(t: TemplateRow) {
        const warning = t.source === "standard"
            ? `"${t.name}" is a GTR standard template. Deleting it removes it for ChatGPT too (the seeder can restore it). Delete?`
            : `Delete "${t.name}"? This can't be undone.`;
        if (!confirm(warning)) return;
        const res = await fetch(`/api/estimate-templates?id=${t.id}`, { method: "DELETE" });
        if (res.ok) {
            toast.success("Template deleted");
            void fetchTemplates();
        } else toast.error("Delete failed");
    }

    return (
        <div>
            <div className="flex justify-between items-start mb-4">
                <div>
                    <h1 className="text-xl font-bold text-hui-textMain">Estimate Templates</h1>
                    <p className="text-sm text-hui-textMuted mt-1">
                        The template library ChatGPT and the estimate editor pull from.
                        <span className="font-medium"> Standard</span> = seeded GTR library; <span className="font-medium">Custom</span> = saved in ProBuild.
                    </p>
                </div>
            </div>

            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs text-blue-800 mb-4">
                <strong>To edit a template&apos;s contents:</strong> insert it into any estimate (Insert Assembly), adjust the items,
                select them and save as a template <em>with the same name</em> — it replaces the existing one instead of creating a duplicate.
            </div>

            {loading ? (
                <p className="text-sm text-hui-textMuted">Loading…</p>
            ) : (
                <div className="bg-white border border-hui-border rounded-lg overflow-hidden">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="bg-slate-50 text-[11px] uppercase tracking-wider text-hui-textMuted">
                                <th className="text-left px-4 py-2.5">Template</th>
                                <th className="text-left px-3 py-2.5">Source</th>
                                <th className="text-right px-3 py-2.5">Items</th>
                                <th className="text-left px-3 py-2.5">Created</th>
                                <th className="text-left px-3 py-2.5">Modified</th>
                                <th className="px-3 py-2.5"></th>
                            </tr>
                        </thead>
                        <tbody>
                            {templates.map(t => (
                                <>
                                    <tr key={t.id} className="border-t border-hui-border hover:bg-slate-50">
                                        <td className="px-4 py-2.5">
                                            <button onClick={() => setExpanded(expanded === t.id ? null : t.id)} className="font-medium text-hui-textMain hover:text-hui-primary text-left">
                                                {t.name}
                                            </button>
                                        </td>
                                        <td className="px-3 py-2.5">
                                            <span className={`text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 ${t.source === "standard" ? "bg-violet-100 text-violet-700" : "bg-slate-100 text-slate-600"}`}>
                                                {t.source}
                                            </span>
                                        </td>
                                        <td className="px-3 py-2.5 text-right text-hui-textMuted">{t.itemCount}</td>
                                        <td className="px-3 py-2.5 text-hui-textMuted">{fmtDate(t.createdAt)}</td>
                                        <td className="px-3 py-2.5 text-hui-textMuted">{t.modified ? fmtDate(t.updatedAt) : "—"}</td>
                                        <td className="px-3 py-2.5 text-right whitespace-nowrap">
                                            <button onClick={() => { setRenaming(t); setRenameValue(t.name); }} className="text-xs text-hui-primary hover:underline mr-3">Rename</button>
                                            <button onClick={() => handleDelete(t)} className="text-xs text-red-600 hover:underline">Delete</button>
                                        </td>
                                    </tr>
                                    {expanded === t.id && (
                                        <tr key={`${t.id}-phases`} className="border-t border-hui-border bg-slate-50">
                                            <td colSpan={6} className="px-6 py-2.5 text-xs text-hui-textMuted">
                                                {t.phases.length > 0
                                                    ? <><span className="font-semibold text-hui-textMain">Phases:</span> {t.phases.join(" → ")}</>
                                                    : "No phase sections (flat item list)."}
                                            </td>
                                        </tr>
                                    )}
                                </>
                            ))}
                            {templates.length === 0 && (
                                <tr><td colSpan={6} className="px-4 py-6 text-center text-hui-textMuted">No templates yet.</td></tr>
                            )}
                        </tbody>
                    </table>
                </div>
            )}

            {renaming && (
                <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
                    <form onSubmit={handleRename} className="bg-white rounded-xl shadow-2xl max-w-md w-full p-6">
                        <h2 className="text-lg font-bold text-hui-textMain mb-3">Rename template</h2>
                        <input
                            value={renameValue}
                            onChange={e => setRenameValue(e.target.value)}
                            className="hui-input w-full mb-4"
                            autoFocus
                        />
                        <div className="flex justify-end gap-3">
                            <button type="button" onClick={() => setRenaming(null)} className="hui-btn hui-btn-secondary">Cancel</button>
                            <button type="submit" className="hui-btn hui-btn-primary">Save</button>
                        </div>
                    </form>
                </div>
            )}
        </div>
    );
}
