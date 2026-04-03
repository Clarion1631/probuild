"use client";
import { useState, useTransition } from "react";
import { createCatalogItem, updateCatalogItem, deleteCatalogItem } from "@/lib/actions";
import { toast } from "sonner";

interface CatalogItem {
    id: string;
    name: string;
    description: string | null;
    unitCost: number;
    unit: string;
    isActive: boolean;
    costCode: { code: string; name: string } | null;
}

interface CostCode {
    id: string;
    code: string;
    name: string;
}

interface Props {
    items: CatalogItem[];
    costCodes: CostCode[];
}

const EMPTY_FORM = { name: "", description: "", unitCost: "", unit: "each", costCodeId: "" };

export default function MyItemsClient({ items: initialItems, costCodes }: Props) {
    const [items, setItems] = useState<CatalogItem[]>(initialItems);
    const [showAdd, setShowAdd] = useState(false);
    const [editId, setEditId] = useState<string | null>(null);
    const [form, setForm] = useState(EMPTY_FORM);
    const [isPending, startTransition] = useTransition();
    const [search, setSearch] = useState("");

    const filtered = items.filter(i =>
        i.name.toLowerCase().includes(search.toLowerCase()) ||
        (i.description || "").toLowerCase().includes(search.toLowerCase())
    );

    function startEdit(item: CatalogItem) {
        setEditId(item.id);
        setForm({
            name: item.name,
            description: item.description ?? "",
            unitCost: item.unitCost.toString(),
            unit: item.unit,
            costCodeId: item.costCode?.code ?? "",
        });
    }

    function handleSaveNew() {
        if (!form.name.trim() || !form.unitCost) return;
        startTransition(async () => {
            try {
                const cc = costCodes.find(c => c.code === form.costCodeId);
                const created = await createCatalogItem({
                    name: form.name,
                    description: form.description || undefined,
                    unitCost: parseFloat(form.unitCost),
                    unit: form.unit,
                    costCodeId: cc?.id,
                });
                setItems(prev => [created as CatalogItem, ...prev]);
                setShowAdd(false);
                setForm(EMPTY_FORM);
                toast.success("Item added");
            } catch {
                toast.error("Failed to add item");
            }
        });
    }

    function handleSaveEdit() {
        if (!editId || !form.name.trim()) return;
        startTransition(async () => {
            try {
                const cc = costCodes.find(c => c.code === form.costCodeId);
                const updated = await updateCatalogItem(editId, {
                    name: form.name,
                    description: form.description || undefined,
                    unitCost: parseFloat(form.unitCost),
                    unit: form.unit,
                    costCodeId: cc?.id || null,
                });
                setItems(prev => prev.map(i => i.id === editId ? updated as CatalogItem : i));
                setEditId(null);
                toast.success("Item updated");
            } catch {
                toast.error("Failed to update item");
            }
        });
    }

    function handleDelete(id: string) {
        if (!confirm("Delete this item?")) return;
        startTransition(async () => {
            try {
                await deleteCatalogItem(id);
                setItems(prev => prev.filter(i => i.id !== id));
                toast.success("Item deleted");
            } catch {
                toast.error("Failed to delete");
            }
        });
    }

    async function handleToggleActive(item: CatalogItem) {
        startTransition(async () => {
            try {
                const updated = await updateCatalogItem(item.id, { isActive: !item.isActive });
                setItems(prev => prev.map(i => i.id === item.id ? updated as CatalogItem : i));
            } catch {
                toast.error("Failed to update");
            }
        });
    }

    const fmt = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });

    return (
        <div className="max-w-4xl mx-auto py-8 px-6 space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-hui-textMain">My Items</h1>
                    <p className="text-sm text-hui-textMuted mt-1">A reusable product catalog for estimate line items.</p>
                </div>
                <button onClick={() => { setShowAdd(true); setForm(EMPTY_FORM); }} className="hui-btn hui-btn-primary text-sm">+ Add Item</button>
            </div>

            <input
                type="text"
                placeholder="Search items..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="hui-input w-full"
            />

            {showAdd && (
                <div className="hui-card p-4 space-y-3">
                    <h3 className="text-sm font-semibold text-hui-textMain">New Item</h3>
                    <div className="grid grid-cols-2 gap-3">
                        <input placeholder="Item name *" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="hui-input col-span-2" />
                        <input placeholder="Description" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} className="hui-input col-span-2" />
                        <div>
                            <label className="block text-xs text-hui-textMuted mb-1">Unit Cost *</label>
                            <input type="number" step="0.01" min="0" placeholder="0.00" value={form.unitCost} onChange={e => setForm(f => ({ ...f, unitCost: e.target.value }))} className="hui-input w-full" />
                        </div>
                        <div>
                            <label className="block text-xs text-hui-textMuted mb-1">Unit</label>
                            <input placeholder="each / sq ft / hr" value={form.unit} onChange={e => setForm(f => ({ ...f, unit: e.target.value }))} className="hui-input w-full" />
                        </div>
                        <div>
                            <label className="block text-xs text-hui-textMuted mb-1">Cost Code</label>
                            <select value={form.costCodeId} onChange={e => setForm(f => ({ ...f, costCodeId: e.target.value }))} className="hui-input w-full">
                                <option value="">— None —</option>
                                {costCodes.map(c => <option key={c.id} value={c.code}>{c.code} · {c.name}</option>)}
                            </select>
                        </div>
                    </div>
                    <div className="flex gap-2 justify-end">
                        <button onClick={() => setShowAdd(false)} className="hui-btn hui-btn-secondary text-sm">Cancel</button>
                        <button onClick={handleSaveNew} disabled={isPending || !form.name.trim() || !form.unitCost} className="hui-btn hui-btn-primary text-sm disabled:opacity-50">
                            {isPending ? "Saving…" : "Save"}
                        </button>
                    </div>
                </div>
            )}

            {filtered.length === 0 ? (
                <div className="hui-card p-12 text-center text-hui-textMuted text-sm">
                    {search ? "No items match your search." : "No items yet. Add one above."}
                </div>
            ) : (
                <div className="hui-card overflow-hidden">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="text-left text-xs text-hui-textMuted uppercase tracking-wide border-b border-hui-border bg-hui-surface">
                                <th className="px-4 py-3">Name</th>
                                <th className="px-4 py-3">Cost Code</th>
                                <th className="px-4 py-3 text-right">Unit Cost</th>
                                <th className="px-4 py-3">Unit</th>
                                <th className="px-4 py-3 text-center">Active</th>
                                <th className="px-4 py-3" />
                            </tr>
                        </thead>
                        <tbody>
                            {filtered.map(item => (
                                editId === item.id ? (
                                    <tr key={item.id} className="border-b border-hui-border bg-hui-surface/30">
                                        <td className="px-4 py-2" colSpan={4}>
                                            <div className="grid grid-cols-4 gap-2">
                                                <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="hui-input text-sm" placeholder="Name" />
                                                <input type="number" value={form.unitCost} onChange={e => setForm(f => ({ ...f, unitCost: e.target.value }))} className="hui-input text-sm" placeholder="Cost" />
                                                <input value={form.unit} onChange={e => setForm(f => ({ ...f, unit: e.target.value }))} className="hui-input text-sm" placeholder="Unit" />
                                                <select value={form.costCodeId} onChange={e => setForm(f => ({ ...f, costCodeId: e.target.value }))} className="hui-input text-sm">
                                                    <option value="">— None —</option>
                                                    {costCodes.map(c => <option key={c.id} value={c.code}>{c.code}</option>)}
                                                </select>
                                            </div>
                                        </td>
                                        <td className="px-4 py-2 text-center" />
                                        <td className="px-4 py-2">
                                            <div className="flex gap-2">
                                                <button onClick={handleSaveEdit} disabled={isPending} className="hui-btn hui-btn-primary text-xs">Save</button>
                                                <button onClick={() => setEditId(null)} className="hui-btn hui-btn-secondary text-xs">Cancel</button>
                                            </div>
                                        </td>
                                    </tr>
                                ) : (
                                    <tr key={item.id} className={`border-b border-hui-border last:border-0 hover:bg-hui-surface/50 ${!item.isActive ? "opacity-50" : ""}`}>
                                        <td className="px-4 py-3">
                                            <p className="font-medium text-hui-textMain">{item.name}</p>
                                            {item.description && <p className="text-xs text-hui-textMuted mt-0.5">{item.description}</p>}
                                        </td>
                                        <td className="px-4 py-3 text-hui-textMuted text-xs">{item.costCode ? `${item.costCode.code}` : "—"}</td>
                                        <td className="px-4 py-3 text-right font-semibold text-hui-textMain">{fmt(item.unitCost)}</td>
                                        <td className="px-4 py-3 text-hui-textMuted">{item.unit}</td>
                                        <td className="px-4 py-3 text-center">
                                            <button onClick={() => handleToggleActive(item)} className={`w-9 h-5 rounded-full transition ${item.isActive ? "bg-hui-primary" : "bg-hui-border"}`}>
                                                <span className={`block w-4 h-4 bg-white rounded-full shadow transition-transform mx-0.5 ${item.isActive ? "translate-x-4" : "translate-x-0"}`} />
                                            </button>
                                        </td>
                                        <td className="px-4 py-3">
                                            <div className="flex gap-3">
                                                <button onClick={() => startEdit(item)} className="text-xs text-hui-primary hover:underline">Edit</button>
                                                <button onClick={() => handleDelete(item.id)} className="text-xs text-red-500 hover:underline">Delete</button>
                                            </div>
                                        </td>
                                    </tr>
                                )
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
