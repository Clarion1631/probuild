"use client";
import { useState, useTransition } from "react";
import { saveCompanySettings } from "@/lib/actions";
import { toast } from "sonner";

interface TaxRate {
    id: string;
    name: string;
    rate: number;
    isDefault: boolean;
}

interface Props {
    initialTaxes: TaxRate[];
}

export default function SalesTaxesClient({ initialTaxes }: Props) {
    const [taxes, setTaxes] = useState<TaxRate[]>(initialTaxes);
    const [showAdd, setShowAdd] = useState(false);
    const [newName, setNewName] = useState("");
    const [newRate, setNewRate] = useState("");
    const [isPending, startTransition] = useTransition();

    function handleAdd() {
        if (!newName.trim() || !newRate) return;
        const newTax: TaxRate = {
            id: Date.now().toString(),
            name: newName.trim(),
            rate: parseFloat(newRate),
            isDefault: taxes.length === 0,
        };
        const updated = [...taxes, newTax];
        setTaxes(updated);
        setNewName("");
        setNewRate("");
        setShowAdd(false);
        saveTaxes(updated);
    }

    function handleDelete(id: string) {
        const updated = taxes.filter(t => t.id !== id);
        // If deleted was default, make first remaining default
        if (taxes.find(t => t.id === id)?.isDefault && updated.length > 0) {
            updated[0].isDefault = true;
        }
        setTaxes(updated);
        saveTaxes(updated);
    }

    function handleSetDefault(id: string) {
        const updated = taxes.map(t => ({ ...t, isDefault: t.id === id }));
        setTaxes(updated);
        saveTaxes(updated);
    }

    function saveTaxes(list: TaxRate[]) {
        startTransition(async () => {
            try {
                await saveCompanySettings({ salesTaxes: JSON.stringify(list) } as any);
                toast.success("Tax rates saved");
            } catch {
                toast.error("Failed to save");
            }
        });
    }

    return (
        <div className="max-w-2xl mx-auto py-8 px-6 space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-hui-textMain">Sales Taxes</h1>
                    <p className="text-sm text-hui-textMuted mt-1">Manage tax rates applied to estimates and invoices.</p>
                </div>
                <button onClick={() => setShowAdd(true)} className="hui-btn hui-btn-primary text-sm">+ Add Rate</button>
            </div>

            {showAdd && (
                <div className="hui-card p-4 space-y-3">
                    <h3 className="text-sm font-semibold text-hui-textMain">New Tax Rate</h3>
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="block text-xs text-hui-textMuted mb-1">Tax Name</label>
                            <input placeholder="e.g. CA Sales Tax" value={newName} onChange={e => setNewName(e.target.value)} className="hui-input w-full" />
                        </div>
                        <div>
                            <label className="block text-xs text-hui-textMuted mb-1">Rate (%)</label>
                            <input type="number" step="0.01" min="0" max="100" placeholder="8.25" value={newRate} onChange={e => setNewRate(e.target.value)} className="hui-input w-full" />
                        </div>
                    </div>
                    <div className="flex gap-2 justify-end">
                        <button onClick={() => setShowAdd(false)} className="hui-btn hui-btn-secondary text-sm">Cancel</button>
                        <button onClick={handleAdd} disabled={!newName.trim() || !newRate} className="hui-btn hui-btn-primary text-sm disabled:opacity-50">Add</button>
                    </div>
                </div>
            )}

            {taxes.length === 0 ? (
                <div className="hui-card p-10 text-center text-hui-textMuted text-sm">No tax rates yet. Add one above.</div>
            ) : (
                <div className="hui-card overflow-hidden">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="text-left text-xs text-hui-textMuted uppercase tracking-wide border-b border-hui-border bg-hui-surface">
                                <th className="px-4 py-3">Name</th>
                                <th className="px-4 py-3 text-right">Rate</th>
                                <th className="px-4 py-3 text-center">Default</th>
                                <th className="px-4 py-3" />
                            </tr>
                        </thead>
                        <tbody>
                            {taxes.map(t => (
                                <tr key={t.id} className="border-b border-hui-border last:border-0 hover:bg-hui-surface/50">
                                    <td className="px-4 py-3 font-medium text-hui-textMain">{t.name}</td>
                                    <td className="px-4 py-3 text-right text-hui-textMuted">{t.rate}%</td>
                                    <td className="px-4 py-3 text-center">
                                        {t.isDefault ? (
                                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">Default</span>
                                        ) : (
                                            <button onClick={() => handleSetDefault(t.id)} className="text-xs text-hui-primary hover:underline">Set default</button>
                                        )}
                                    </td>
                                    <td className="px-4 py-3 text-right">
                                        <button onClick={() => handleDelete(t.id)} className="text-xs text-red-500 hover:underline">Remove</button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
