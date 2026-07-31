"use client";

// Decision Template CRUD (Phase 3 —
// docs/superpowers/plans/2026-07-31-selection-templates-due-dates.md).
// List layout template per DESIGN_SYSTEM.md.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import * as Dialog from "@radix-ui/react-dialog";
import { createDecisionTemplate, updateDecisionTemplate, archiveDecisionTemplate } from "@/lib/actions";
import { Plus, Pencil, Archive, Trash2, ArrowUp, ArrowDown } from "lucide-react";

export type TemplateItemDraft = {
    key: string; // client-only stable key for React lists, not persisted
    // True for a row loaded from an existing DecisionTemplateItem (key ===
    // that item's real id) — false for a row added via "Add item" in this
    // session (key is a throwaway crypto.randomUUID()). Distinguishes them
    // on save so updateDecisionTemplate can update matched rows in place
    // instead of delete-all-recreate (Codex review round 1, issue 2) — a
    // brand-new row must never be sent with an `id`.
    isExisting: boolean;
    name: string;
    area: string;
    defaultLeadTimeDays: string; // kept as string while editing, parsed on save
    scheduleHint: string;
};

export type TemplateView = {
    id: string;
    name: string;
    description: string | null;
    archivedAt: string | null;
    items: {
        id: string;
        name: string;
        area: string | null;
        defaultLeadTimeDays: number | null;
        scheduleHint: string | null;
        order: number;
    }[];
};

function emptyItem(): TemplateItemDraft {
    return { key: crypto.randomUUID(), isExisting: false, name: "", area: "", defaultLeadTimeDays: "", scheduleHint: "" };
}

function draftsFromTemplate(template: TemplateView | null): TemplateItemDraft[] {
    return template && template.items.length > 0
        ? template.items.map((i) => ({
              key: i.id,
              isExisting: true,
              name: i.name,
              area: i.area ?? "",
              defaultLeadTimeDays: i.defaultLeadTimeDays !== null ? String(i.defaultLeadTimeDays) : "",
              scheduleHint: i.scheduleHint ?? "",
          }))
        : [emptyItem()];
}

function TemplateEditorModal({
    open,
    template,
    onClose,
    onSaved,
}: {
    open: boolean;
    template: TemplateView | null; // null = creating
    onClose: () => void;
    onSaved: () => void;
}) {
    const [name, setName] = useState(template?.name ?? "");
    const [description, setDescription] = useState(template?.description ?? "");
    const [items, setItems] = useState<TemplateItemDraft[]>(draftsFromTemplate(template));
    const [saving, setSaving] = useState(false);
    // Re-seed whenever the modal OPENS (Codex review round 1, nit c — the
    // previous version only reseeded when the `template` prop reference
    // changed, so closing without saving and reopening the SAME template
    // left the abandoned draft in place instead of the persisted values) OR
    // a different template opens while already open. React's "adjusting
    // state when a prop changes" pattern, avoiding an extra render/useEffect.
    const [seededFor, setSeededFor] = useState(template);
    const [seededOpen, setSeededOpen] = useState(open);
    if (open && (!seededOpen || template !== seededFor)) {
        setSeededFor(template);
        setName(template?.name ?? "");
        setDescription(template?.description ?? "");
        setItems(draftsFromTemplate(template));
    }
    if (open !== seededOpen) {
        setSeededOpen(open);
    }

    function updateItem(key: string, patch: Partial<TemplateItemDraft>) {
        setItems((prev) => prev.map((it) => (it.key === key ? { ...it, ...patch } : it)));
    }
    function addItem() {
        setItems((prev) => [...prev, emptyItem()]);
    }
    function removeItem(key: string) {
        setItems((prev) => (prev.length > 1 ? prev.filter((it) => it.key !== key) : prev));
    }
    function moveItem(key: string, direction: "up" | "down") {
        setItems((prev) => {
            const index = prev.findIndex((it) => it.key === key);
            if (index === -1) return prev;
            const targetIndex = direction === "up" ? index - 1 : index + 1;
            if (targetIndex < 0 || targetIndex >= prev.length) return prev;
            const next = [...prev];
            [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
            return next;
        });
    }

    async function handleSave() {
        const trimmedName = name.trim();
        if (!trimmedName) {
            toast.error("Template name is required.");
            return;
        }
        const cleanItems = items
            .filter((it) => it.name.trim())
            .map((it) => ({
                // Only an EXISTING row's real id is forwarded — a row added
                // in this session (isExisting: false) must never carry one,
                // so updateDecisionTemplate creates it fresh rather than
                // trying to update a nonexistent row (Codex review round 1,
                // issue 2).
                id: it.isExisting ? it.key : undefined,
                name: it.name.trim(),
                area: it.area.trim() || undefined,
                scheduleHint: it.scheduleHint.trim() || undefined,
                defaultLeadTimeDays: it.defaultLeadTimeDays.trim() === "" ? undefined : Number(it.defaultLeadTimeDays),
            }));
        if (cleanItems.length === 0) {
            toast.error("At least one item is required.");
            return;
        }

        setSaving(true);
        try {
            const input = { name: trimmedName, description: description.trim() || undefined, items: cleanItems };
            if (template) {
                await updateDecisionTemplate(template.id, input);
                toast.success("Template updated.");
            } else {
                await createDecisionTemplate(input);
                toast.success("Template created.");
            }
            onSaved();
            onClose();
        } catch (e: any) {
            toast.error(e?.message || "Couldn't save that template.");
        } finally {
            setSaving(false);
        }
    }

    return (
        <Dialog.Root open={open} onOpenChange={(next) => { if (!next && !saving) onClose(); }}>
            <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 bg-black/40 z-50" />
                <Dialog.Content
                    data-testid="decision-template-editor-modal"
                    className="fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 bg-white rounded-xl shadow-2xl max-w-2xl w-[calc(100vw-2rem)] max-h-[85vh] flex flex-col focus:outline-none"
                >
                    <div className="px-6 py-4 border-b border-hui-border">
                        <Dialog.Title className="text-lg font-bold text-hui-textMain">
                            {template ? "Edit template" : "New selection template"}
                        </Dialog.Title>
                        <Dialog.Description className="text-xs text-hui-textMuted mt-0.5">
                            One decision category is created per item when this is applied to a project.
                        </Dialog.Description>
                    </div>

                    <div className="overflow-y-auto p-6 space-y-4">
                        <div>
                            <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Name</label>
                            <input
                                data-testid="template-name-input"
                                className="hui-input mt-1"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                placeholder="Kitchen Remodel"
                                disabled={saving}
                            />
                        </div>
                        <div>
                            <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Description</label>
                            <input
                                className="hui-input mt-1"
                                value={description}
                                onChange={(e) => setDescription(e.target.value)}
                                placeholder="Optional"
                                disabled={saving}
                            />
                        </div>

                        <div>
                            <div className="flex items-center justify-between mb-2">
                                <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Items</label>
                                <button onClick={addItem} disabled={saving} className="hui-btn hui-btn-secondary text-xs py-1 px-2 flex items-center gap-1">
                                    <Plus className="w-3 h-3" /> Add item
                                </button>
                            </div>
                            <div className="space-y-2">
                                {items.map((item, i) => (
                                    <div key={item.key} data-testid={`template-item-row-${i}`} className="grid grid-cols-12 gap-2 items-center border border-slate-200 rounded-lg p-2">
                                        <input
                                            data-testid={`template-item-name-${i}`}
                                            className="hui-input text-sm col-span-3"
                                            value={item.name}
                                            onChange={(e) => updateItem(item.key, { name: e.target.value })}
                                            placeholder="Name (e.g. Cabinets)"
                                            disabled={saving}
                                        />
                                        <input
                                            className="hui-input text-sm col-span-3"
                                            value={item.area}
                                            onChange={(e) => updateItem(item.key, { area: e.target.value })}
                                            placeholder="Area"
                                            disabled={saving}
                                        />
                                        <input
                                            data-testid={`template-item-lead-time-${i}`}
                                            type="number"
                                            min={0}
                                            max={365}
                                            className="hui-input text-sm col-span-2"
                                            value={item.defaultLeadTimeDays}
                                            onChange={(e) => updateItem(item.key, { defaultLeadTimeDays: e.target.value })}
                                            placeholder="Lead days"
                                            disabled={saving}
                                        />
                                        <input
                                            className="hui-input text-sm col-span-2"
                                            value={item.scheduleHint}
                                            onChange={(e) => updateItem(item.key, { scheduleHint: e.target.value })}
                                            placeholder="Schedule hint"
                                            disabled={saving}
                                        />
                                        <div className="col-span-1 flex justify-center gap-0.5">
                                            <button
                                                data-testid={`template-item-move-up-${i}`}
                                                onClick={() => moveItem(item.key, "up")}
                                                disabled={saving || i === 0}
                                                title="Move up"
                                                aria-label="Move item up"
                                                className="text-slate-400 hover:text-hui-textMain disabled:opacity-30"
                                            >
                                                <ArrowUp className="w-3.5 h-3.5" />
                                            </button>
                                            <button
                                                data-testid={`template-item-move-down-${i}`}
                                                onClick={() => moveItem(item.key, "down")}
                                                disabled={saving || i === items.length - 1}
                                                title="Move down"
                                                aria-label="Move item down"
                                                className="text-slate-400 hover:text-hui-textMain disabled:opacity-30"
                                            >
                                                <ArrowDown className="w-3.5 h-3.5" />
                                            </button>
                                        </div>
                                        <button
                                            onClick={() => removeItem(item.key)}
                                            disabled={saving || items.length === 1}
                                            title="Remove item"
                                            className="col-span-1 flex justify-center text-slate-400 hover:text-red-600 disabled:opacity-30"
                                        >
                                            <Trash2 className="w-4 h-4" />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>

                    <div className="px-6 py-4 border-t border-hui-border flex justify-end gap-3 bg-slate-50 rounded-b-xl">
                        <button onClick={onClose} disabled={saving} className="hui-btn hui-btn-secondary">Cancel</button>
                        <button data-testid="template-save-button" onClick={handleSave} disabled={saving} className="hui-btn hui-btn-green disabled:opacity-50">
                            {saving ? "Saving…" : "Save"}
                        </button>
                    </div>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}

export default function DecisionTemplatesManager({ initialTemplates }: { initialTemplates: TemplateView[] }) {
    const router = useRouter();
    const [templates, setTemplates] = useState(initialTemplates);
    const [editorOpen, setEditorOpen] = useState(false);
    const [editing, setEditing] = useState<TemplateView | null>(null);
    const [archiving, setArchiving] = useState<string | null>(null);
    // Archive has no undo (Codex review round 1, issue 8) — confirm first,
    // same plain-overlay house pattern as DecisionCard's delete confirm on
    // the staff selections page.
    const [confirmArchive, setConfirmArchive] = useState<TemplateView | null>(null);

    function refresh() {
        router.refresh();
    }

    async function handleArchive(template: TemplateView) {
        setArchiving(template.id);
        try {
            await archiveDecisionTemplate(template.id);
            toast.success("Template archived.");
            setConfirmArchive(null);
            refresh();
        } catch (e: any) {
            toast.error(e?.message || "Couldn't archive that template.");
        } finally {
            setArchiving(null);
        }
    }

    // initialTemplates is only the INITIAL value — resync after
    // router.refresh() re-fetches server data.
    if (initialTemplates !== templates && editorOpen === false && archiving === null) {
        // Cheap resync without an effect: only when nothing is mid-flight.
        setTemplates(initialTemplates);
    }

    return (
        <div className="max-w-4xl mx-auto py-8 px-6 space-y-6">
            <div className="flex items-center justify-between mb-2 flex-wrap gap-3">
                <div>
                    <h1 className="text-2xl font-bold text-hui-textMain">Selection Templates</h1>
                    <p className="text-sm text-hui-textMuted mt-1">{templates.length} template{templates.length === 1 ? "" : "s"}</p>
                </div>
                <button
                    data-testid="new-template-button"
                    onClick={() => { setEditing(null); setEditorOpen(true); }}
                    className="hui-btn hui-btn-green text-sm flex items-center gap-1.5"
                >
                    <Plus className="w-4 h-4" /> New template
                </button>
            </div>

            {templates.length === 0 ? (
                <div className="hui-card p-12 text-center">
                    <p className="text-sm text-hui-textMuted">No selection templates yet. Create one to reuse across projects.</p>
                </div>
            ) : (
                <div className="hui-card">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b border-hui-border bg-slate-50">
                                <th className="text-left px-4 py-2.5 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Name</th>
                                <th className="text-left px-4 py-2.5 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Items</th>
                                <th className="text-left px-4 py-2.5 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Status</th>
                                <th className="text-right px-4 py-2.5 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                            {templates.map((t) => (
                                <tr key={t.id} data-testid={`template-row-${t.id}`} className="hover:bg-slate-50 transition">
                                    <td className="px-4 py-2.5 font-medium text-hui-textMain">
                                        {t.name}
                                        {t.description && <p className="text-xs text-hui-textMuted font-normal">{t.description}</p>}
                                    </td>
                                    <td className="px-4 py-2.5 text-hui-textMain">{t.items.length}</td>
                                    <td className="px-4 py-2.5">
                                        {t.archivedAt ? (
                                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-600">Archived</span>
                                        ) : (
                                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">Active</span>
                                        )}
                                    </td>
                                    <td className="px-4 py-2.5">
                                        <div className="flex items-center justify-end gap-2">
                                            <button
                                                onClick={() => { setEditing(t); setEditorOpen(true); }}
                                                title="Edit"
                                                className="w-7 h-7 rounded-md flex items-center justify-center text-slate-400 hover:text-hui-textMain hover:bg-slate-100 transition"
                                            >
                                                <Pencil className="w-4 h-4" />
                                            </button>
                                            {!t.archivedAt && (
                                                <button
                                                    data-testid={`archive-template-${t.id}`}
                                                    onClick={() => setConfirmArchive(t)}
                                                    disabled={archiving === t.id}
                                                    title="Archive"
                                                    className="w-7 h-7 rounded-md flex items-center justify-center text-slate-400 hover:text-red-600 hover:bg-red-50 transition disabled:opacity-50"
                                                >
                                                    <Archive className="w-4 h-4" />
                                                </button>
                                            )}
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            <TemplateEditorModal
                open={editorOpen}
                template={editing}
                onClose={() => setEditorOpen(false)}
                onSaved={refresh}
            />

            {confirmArchive && (
                <div
                    className="fixed inset-0 bg-slate-900/50 flex items-center justify-center z-50 p-4"
                    onClick={() => archiving === null && setConfirmArchive(null)}
                >
                    <div
                        data-testid="confirm-archive-template-modal"
                        className="bg-white rounded-xl shadow-xl w-full max-w-sm border border-hui-border"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="p-6">
                            <h3 className="text-base font-bold text-hui-textMain mb-2">Archive &quot;{confirmArchive.name}&quot;?</h3>
                            <p className="text-sm text-hui-textMuted">
                                Projects that already applied it keep working — this just hides it from new applications. There&apos;s no undo from here; you&apos;d need to create a new template with the same items.
                            </p>
                        </div>
                        <div className="px-6 py-4 border-t border-hui-border flex justify-end gap-3 bg-slate-50 rounded-b-xl">
                            <button onClick={() => setConfirmArchive(null)} disabled={archiving !== null} className="hui-btn hui-btn-secondary">Cancel</button>
                            <button
                                data-testid="confirm-archive-template-button"
                                onClick={() => handleArchive(confirmArchive)}
                                disabled={archiving !== null}
                                className="hui-btn hui-btn-primary disabled:opacity-50"
                            >
                                {archiving === confirmArchive.id ? "Archiving…" : "Archive"}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
