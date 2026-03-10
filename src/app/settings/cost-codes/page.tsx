"use client";

import { useState, useEffect } from "react";
import { toast } from "sonner";

type CostCode = {
    id: string;
    code: string;
    name: string;
    description: string | null;
    type: string;
    isActive: boolean;
};

export default function CostCodesPage() {
    const [costCodes, setCostCodes] = useState<CostCode[]>([]);
    const [loading, setLoading] = useState(true);
    const [showModal, setShowModal] = useState(false);
    const [editingCode, setEditingCode] = useState<CostCode | null>(null);
    const [form, setForm] = useState({ code: "", name: "", description: "", type: "Labor" });

    useEffect(() => {
        fetchCostCodes();
    }, []);

    async function fetchCostCodes() {
        const res = await fetch('/api/cost-codes');
        if (res.ok) {
            setCostCodes(await res.json());
        }
        setLoading(false);
    }

    function openAdd() {
        setEditingCode(null);
        setForm({ code: "", name: "", description: "", type: "Labor" });
        setShowModal(true);
    }

    function openEdit(cc: CostCode) {
        setEditingCode(cc);
        setForm({ code: cc.code, name: cc.name, description: cc.description || "", type: cc.type });
        setShowModal(true);
    }

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        const method = editingCode ? 'PUT' : 'POST';
        const body = editingCode ? { id: editingCode.id, ...form } : form;

        const res = await fetch('/api/cost-codes', {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

        if (res.ok) {
            toast.success(editingCode ? "Cost code updated" : "Cost code created");
            setShowModal(false);
            fetchCostCodes();
        } else {
            const data = await res.json();
            toast.error(data.error || "Failed to save");
        }
    }

    async function toggleActive(cc: CostCode) {
        const res = await fetch('/api/cost-codes', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: cc.id, isActive: !cc.isActive }),
        });
        if (res.ok) {
            toast.success(cc.isActive ? "Deactivated" : "Activated");
            fetchCostCodes();
        }
    }

    const typeColors: Record<string, string> = {
        Labor: "bg-blue-50 text-blue-700 border-blue-200",
        Material: "bg-amber-50 text-amber-700 border-amber-200",
        Subcontractor: "bg-purple-50 text-purple-700 border-purple-200",
        Equipment: "bg-green-50 text-green-700 border-green-200",
    };

    return (
        <div className="font-sans text-slate-900 h-full flex flex-col">
            <header className="bg-white border-b border-hui-border px-8 py-4 flex items-center justify-between sticky top-0 z-10">
                <div>
                    <h1 className="text-xl font-bold text-hui-textMain">Cost Codes</h1>
                    <p className="text-sm text-hui-textMuted mt-0.5">Manage your company-wide cost code repository. These drive estimate phases, time entries, and expenses.</p>
                </div>
                <button onClick={openAdd} className="hui-btn hui-btn-primary">+ Add Cost Code</button>
            </header>

            <div className="p-8 flex-1 overflow-y-auto bg-hui-background">
                {loading ? (
                    <div className="text-center py-20 text-hui-textMuted">Loading cost codes...</div>
                ) : costCodes.length === 0 ? (
                    <div className="hui-card p-12 text-center">
                        <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-4">
                            <svg className="w-8 h-8 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" /></svg>
                        </div>
                        <h3 className="text-lg font-medium text-slate-900 mb-1">No cost codes yet</h3>
                        <p className="text-slate-500 mb-6">Add your first cost code to start categorizing work phases.</p>
                        <button onClick={openAdd} className="hui-btn hui-btn-primary">+ Add Your First Cost Code</button>
                    </div>
                ) : (
                    <div className="hui-card overflow-hidden max-w-5xl mx-auto">
                        <table className="w-full text-left border-collapse">
                            <thead>
                                <tr className="bg-slate-50 border-b border-hui-border text-xs font-semibold text-hui-textMuted uppercase tracking-wider">
                                    <th className="px-6 py-4 font-medium">Code</th>
                                    <th className="px-6 py-4 font-medium">Name</th>
                                    <th className="px-6 py-4 font-medium">Type</th>
                                    <th className="px-6 py-4 font-medium">Status</th>
                                    <th className="px-6 py-4 font-medium text-right">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-hui-border text-sm">
                                {costCodes.map(cc => (
                                    <tr key={cc.id} className="hover:bg-slate-50 transition-colors group">
                                        <td className="px-6 py-4 font-mono font-bold text-hui-textMain">{cc.code}</td>
                                        <td className="px-6 py-4">
                                            <div className="font-medium text-hui-textMain">{cc.name}</div>
                                            {cc.description && <div className="text-xs text-hui-textMuted mt-0.5">{cc.description}</div>}
                                        </td>
                                        <td className="px-6 py-4">
                                            <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${typeColors[cc.type] || 'bg-slate-50 text-slate-700 border-slate-200'}`}>
                                                {cc.type}
                                            </span>
                                        </td>
                                        <td className="px-6 py-4">
                                            <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium ${cc.isActive ? 'bg-green-50 text-green-700' : 'bg-slate-100 text-slate-500'}`}>
                                                <span className={`w-1.5 h-1.5 rounded-full ${cc.isActive ? 'bg-green-500' : 'bg-slate-400'}`}></span>
                                                {cc.isActive ? "Active" : "Inactive"}
                                            </span>
                                        </td>
                                        <td className="px-6 py-4 text-right">
                                            <div className="flex justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                                <button onClick={() => openEdit(cc)} className="text-blue-600 hover:text-blue-800 font-medium text-sm">Edit</button>
                                                <button onClick={() => toggleActive(cc)} className={`font-medium text-sm ${cc.isActive ? 'text-amber-600 hover:text-amber-800' : 'text-green-600 hover:text-green-800'}`}>
                                                    {cc.isActive ? "Deactivate" : "Activate"}
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {/* Add/Edit Modal */}
            {showModal && (
                <div className="fixed inset-0 bg-slate-900/50 flex items-center justify-center z-50 p-4">
                    <div className="bg-white rounded-xl shadow-xl max-w-md w-full overflow-hidden border border-hui-border">
                        <div className="px-6 py-4 border-b border-hui-border flex justify-between items-center">
                            <h2 className="text-lg font-bold text-hui-textMain">{editingCode ? 'Edit Cost Code' : 'Add Cost Code'}</h2>
                            <button onClick={() => setShowModal(false)} className="text-hui-textMuted hover:text-hui-textMain transition">
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                            </button>
                        </div>
                        <form onSubmit={handleSubmit} className="p-6 space-y-4 text-sm">
                            <div>
                                <label className="block font-medium text-hui-textMain mb-1">Code <span className="text-red-500">*</span></label>
                                <input required type="text" placeholder="e.g. 01-DEMO" className="hui-input w-full uppercase" value={form.code} onChange={e => setForm({ ...form, code: e.target.value })} />
                                <p className="text-xs text-hui-textMuted mt-1">Unique identifier, e.g. "01-DEMO", "02-FRAME"</p>
                            </div>
                            <div>
                                <label className="block font-medium text-hui-textMain mb-1">Name <span className="text-red-500">*</span></label>
                                <input required type="text" placeholder="e.g. Demolition" className="hui-input w-full" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
                            </div>
                            <div>
                                <label className="block font-medium text-hui-textMain mb-1">Description</label>
                                <input type="text" placeholder="Optional description" className="hui-input w-full" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
                            </div>
                            <div>
                                <label className="block font-medium text-hui-textMain mb-1">Type</label>
                                <select className="hui-input w-full" value={form.type} onChange={e => setForm({ ...form, type: e.target.value })}>
                                    <option value="Labor">Labor</option>
                                    <option value="Material">Material</option>
                                    <option value="Subcontractor">Subcontractor</option>
                                    <option value="Equipment">Equipment</option>
                                </select>
                            </div>
                            <div className="pt-4 flex justify-end gap-3 border-t border-hui-border mt-6">
                                <button type="button" onClick={() => setShowModal(false)} className="hui-btn hui-btn-secondary">Cancel</button>
                                <button type="submit" className="hui-btn hui-btn-primary">{editingCode ? 'Save Changes' : 'Create'}</button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}
