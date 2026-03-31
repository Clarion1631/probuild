"use client";
export const dynamic = "force-dynamic";

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

type CostType = {
    id: string;
    name: string;
    description: string | null;
    isActive: boolean;
};

export default function CostCodesPage() {
    const [activeTab, setActiveTab] = useState<"phases" | "costTypes">("phases");

    // Phases (cost codes)
    const [costCodes, setCostCodes] = useState<CostCode[]>([]);
    const [loadingCodes, setLoadingCodes] = useState(true);
    const [showCodeModal, setShowCodeModal] = useState(false);
    const [editingCode, setEditingCode] = useState<CostCode | null>(null);
    const [codeForm, setCodeForm] = useState({ code: "", name: "", description: "" });

    // Cost Types
    const [costTypes, setCostTypes] = useState<CostType[]>([]);
    const [loadingTypes, setLoadingTypes] = useState(true);
    const [showTypeModal, setShowTypeModal] = useState(false);
    const [editingType, setEditingType] = useState<CostType | null>(null);
    const [typeForm, setTypeForm] = useState({ name: "", description: "" });

    useEffect(() => {
        fetchCostCodes();
        fetchCostTypes();
    }, []);

    async function fetchCostCodes() {
        const res = await fetch('/api/cost-codes');
        if (res.ok) setCostCodes(await res.json());
        setLoadingCodes(false);
    }

    async function fetchCostTypes() {
        const res = await fetch('/api/cost-types');
        if (res.ok) setCostTypes(await res.json());
        setLoadingTypes(false);
    }

    // --- Phase CRUD ---
    function openAddCode() {
        setEditingCode(null);
        setCodeForm({ code: "", name: "", description: "" });
        setShowCodeModal(true);
    }

    function openEditCode(cc: CostCode) {
        setEditingCode(cc);
        setCodeForm({ code: cc.code, name: cc.name, description: cc.description || "" });
        setShowCodeModal(true);
    }

    async function handleCodeSubmit(e: React.FormEvent) {
        e.preventDefault();
        const method = editingCode ? 'PUT' : 'POST';
        const body = editingCode ? { id: editingCode.id, ...codeForm } : codeForm;
        const res = await fetch('/api/cost-codes', {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (res.ok) {
            toast.success(editingCode ? "Phase updated" : "Phase created");
            setShowCodeModal(false);
            fetchCostCodes();
        } else {
            const data = await res.json();
            toast.error(data.error || "Failed to save");
        }
    }

    async function toggleCodeActive(cc: CostCode) {
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

    // --- Cost Type CRUD ---
    function openAddType() {
        setEditingType(null);
        setTypeForm({ name: "", description: "" });
        setShowTypeModal(true);
    }

    function openEditType(ct: CostType) {
        setEditingType(ct);
        setTypeForm({ name: ct.name, description: ct.description || "" });
        setShowTypeModal(true);
    }

    async function handleTypeSubmit(e: React.FormEvent) {
        e.preventDefault();
        const method = editingType ? 'PUT' : 'POST';
        const body = editingType ? { id: editingType.id, ...typeForm } : typeForm;
        const res = await fetch('/api/cost-types', {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (res.ok) {
            toast.success(editingType ? "Cost type updated" : "Cost type created");
            setShowTypeModal(false);
            fetchCostTypes();
        } else {
            const data = await res.json();
            toast.error(data.error || "Failed to save");
        }
    }

    async function toggleTypeActive(ct: CostType) {
        const res = await fetch('/api/cost-types', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: ct.id, isActive: !ct.isActive }),
        });
        if (res.ok) {
            toast.success(ct.isActive ? "Deactivated" : "Activated");
            fetchCostTypes();
        }
    }

    return (
        <div className="font-sans text-slate-900 h-full flex flex-col">
            <header className="bg-white border-b border-hui-border px-8 py-4 flex items-center justify-between sticky top-0 z-10">
                <div>
                    <h1 className="text-xl font-bold text-hui-textMain">Phases & Cost Types</h1>
                    <p className="text-sm text-hui-textMuted mt-0.5">Manage work phases and cost categories for estimates, time entries, and expenses.</p>
                </div>
                <button
                    onClick={activeTab === "phases" ? openAddCode : openAddType}
                    className="hui-btn hui-btn-primary"
                >
                    + Add {activeTab === "phases" ? "Phase" : "Cost Type"}
                </button>
            </header>

            {/* Tabs */}
            <div className="bg-white border-b border-hui-border px-8">
                <div className="flex gap-1">
                    <button
                        onClick={() => setActiveTab("phases")}
                        className={`px-5 py-3 text-sm font-medium border-b-2 transition ${activeTab === "phases"
                            ? "border-hui-primary text-hui-primary"
                            : "border-transparent text-hui-textMuted hover:text-hui-textMain"
                        }`}
                    >
                        Phases ({costCodes.length})
                    </button>
                    <button
                        onClick={() => setActiveTab("costTypes")}
                        className={`px-5 py-3 text-sm font-medium border-b-2 transition ${activeTab === "costTypes"
                            ? "border-hui-primary text-hui-primary"
                            : "border-transparent text-hui-textMuted hover:text-hui-textMain"
                        }`}
                    >
                        Cost Types ({costTypes.length})
                    </button>
                </div>
            </div>

            <div className="p-8 flex-1 overflow-y-auto bg-hui-background">
                {/* === PHASES TAB === */}
                {activeTab === "phases" && (
                    <>
                        {loadingCodes ? (
                            <div className="text-center py-20 text-hui-textMuted">Loading phases...</div>
                        ) : costCodes.length === 0 ? (
                            <div className="hui-card p-12 text-center">
                                <h3 className="text-lg font-medium text-slate-900 mb-1">No phases yet</h3>
                                <p className="text-slate-500 mb-6">Add work phases like Demolition, Framing, Plumbing, etc.</p>
                                <button onClick={openAddCode} className="hui-btn hui-btn-primary">+ Add Your First Phase</button>
                            </div>
                        ) : (
                            <div className="hui-card overflow-hidden max-w-5xl mx-auto">
                                <table className="w-full text-left border-collapse">
                                    <thead>
                                        <tr className="bg-slate-50 border-b border-hui-border text-xs font-semibold text-hui-textMuted uppercase tracking-wider">
                                            <th className="px-6 py-4 font-medium">Code</th>
                                            <th className="px-6 py-4 font-medium">Phase Name</th>
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
                                                    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium ${cc.isActive ? 'bg-green-50 text-green-700' : 'bg-slate-100 text-slate-500'}`}>
                                                        <span className={`w-1.5 h-1.5 rounded-full ${cc.isActive ? 'bg-green-500' : 'bg-slate-400'}`}></span>
                                                        {cc.isActive ? "Active" : "Inactive"}
                                                    </span>
                                                </td>
                                                <td className="px-6 py-4 text-right">
                                                    <div className="flex justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                                        <button onClick={() => openEditCode(cc)} className="text-blue-600 hover:text-blue-800 font-medium text-sm">Edit</button>
                                                        <button onClick={() => toggleCodeActive(cc)} className={`font-medium text-sm ${cc.isActive ? 'text-amber-600 hover:text-amber-800' : 'text-green-600 hover:text-green-800'}`}>
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
                    </>
                )}

                {/* === COST TYPES TAB === */}
                {activeTab === "costTypes" && (
                    <>
                        {loadingTypes ? (
                            <div className="text-center py-20 text-hui-textMuted">Loading cost types...</div>
                        ) : costTypes.length === 0 ? (
                            <div className="hui-card p-12 text-center">
                                <h3 className="text-lg font-medium text-slate-900 mb-1">No cost types yet</h3>
                                <p className="text-slate-500 mb-6">Add cost types like Labor, Material, Unit, Allowance, etc.</p>
                                <button onClick={openAddType} className="hui-btn hui-btn-primary">+ Add Your First Cost Type</button>
                            </div>
                        ) : (
                            <div className="hui-card overflow-hidden max-w-4xl mx-auto">
                                <table className="w-full text-left border-collapse">
                                    <thead>
                                        <tr className="bg-slate-50 border-b border-hui-border text-xs font-semibold text-hui-textMuted uppercase tracking-wider">
                                            <th className="px-6 py-4 font-medium">Name</th>
                                            <th className="px-6 py-4 font-medium">Description</th>
                                            <th className="px-6 py-4 font-medium">Status</th>
                                            <th className="px-6 py-4 font-medium text-right">Actions</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-hui-border text-sm">
                                        {costTypes.map(ct => (
                                            <tr key={ct.id} className="hover:bg-slate-50 transition-colors group">
                                                <td className="px-6 py-4 font-semibold text-hui-textMain">{ct.name}</td>
                                                <td className="px-6 py-4 text-hui-textMuted">{ct.description || "—"}</td>
                                                <td className="px-6 py-4">
                                                    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium ${ct.isActive ? 'bg-green-50 text-green-700' : 'bg-slate-100 text-slate-500'}`}>
                                                        <span className={`w-1.5 h-1.5 rounded-full ${ct.isActive ? 'bg-green-500' : 'bg-slate-400'}`}></span>
                                                        {ct.isActive ? "Active" : "Inactive"}
                                                    </span>
                                                </td>
                                                <td className="px-6 py-4 text-right">
                                                    <div className="flex justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                                        <button onClick={() => openEditType(ct)} className="text-blue-600 hover:text-blue-800 font-medium text-sm">Edit</button>
                                                        <button onClick={() => toggleTypeActive(ct)} className={`font-medium text-sm ${ct.isActive ? 'text-amber-600 hover:text-amber-800' : 'text-green-600 hover:text-green-800'}`}>
                                                            {ct.isActive ? "Deactivate" : "Activate"}
                                                        </button>
                                                    </div>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </>
                )}
            </div>

            {/* Phase Add/Edit Modal */}
            {showCodeModal && (
                <div className="fixed inset-0 bg-slate-900/50 flex items-center justify-center z-50 p-4">
                    <div className="bg-white rounded-xl shadow-xl max-w-md w-full overflow-hidden border border-hui-border">
                        <div className="px-6 py-4 border-b border-hui-border flex justify-between items-center">
                            <h2 className="text-lg font-bold text-hui-textMain">{editingCode ? 'Edit Phase' : 'Add Phase'}</h2>
                            <button onClick={() => setShowCodeModal(false)} className="text-hui-textMuted hover:text-hui-textMain transition">
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                            </button>
                        </div>
                        <form onSubmit={handleCodeSubmit} className="p-6 space-y-4 text-sm">
                            <div>
                                <label className="block font-medium text-hui-textMain mb-1">Code <span className="text-red-500">*</span></label>
                                <input required type="text" placeholder="e.g. 01-DEMO" className="hui-input w-full uppercase" value={codeForm.code} onChange={e => setCodeForm({ ...codeForm, code: e.target.value })} />
                            </div>
                            <div>
                                <label className="block font-medium text-hui-textMain mb-1">Name <span className="text-red-500">*</span></label>
                                <input required type="text" placeholder="e.g. Demolition" className="hui-input w-full" value={codeForm.name} onChange={e => setCodeForm({ ...codeForm, name: e.target.value })} />
                            </div>
                            <div>
                                <label className="block font-medium text-hui-textMain mb-1">Description</label>
                                <input type="text" placeholder="Optional description" className="hui-input w-full" value={codeForm.description} onChange={e => setCodeForm({ ...codeForm, description: e.target.value })} />
                            </div>
                            <div className="pt-4 flex justify-end gap-3 border-t border-hui-border mt-6">
                                <button type="button" onClick={() => setShowCodeModal(false)} className="hui-btn hui-btn-secondary">Cancel</button>
                                <button type="submit" className="hui-btn hui-btn-primary">{editingCode ? 'Save Changes' : 'Create'}</button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* Cost Type Add/Edit Modal */}
            {showTypeModal && (
                <div className="fixed inset-0 bg-slate-900/50 flex items-center justify-center z-50 p-4">
                    <div className="bg-white rounded-xl shadow-xl max-w-md w-full overflow-hidden border border-hui-border">
                        <div className="px-6 py-4 border-b border-hui-border flex justify-between items-center">
                            <h2 className="text-lg font-bold text-hui-textMain">{editingType ? 'Edit Cost Type' : 'Add Cost Type'}</h2>
                            <button onClick={() => setShowTypeModal(false)} className="text-hui-textMuted hover:text-hui-textMain transition">
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                            </button>
                        </div>
                        <form onSubmit={handleTypeSubmit} className="p-6 space-y-4 text-sm">
                            <div>
                                <label className="block font-medium text-hui-textMain mb-1">Name <span className="text-red-500">*</span></label>
                                <input required type="text" placeholder="e.g. Allowance" className="hui-input w-full" value={typeForm.name} onChange={e => setTypeForm({ ...typeForm, name: e.target.value })} />
                            </div>
                            <div>
                                <label className="block font-medium text-hui-textMain mb-1">Description</label>
                                <input type="text" placeholder="Optional description" className="hui-input w-full" value={typeForm.description} onChange={e => setTypeForm({ ...typeForm, description: e.target.value })} />
                            </div>
                            <div className="pt-4 flex justify-end gap-3 border-t border-hui-border mt-6">
                                <button type="button" onClick={() => setShowTypeModal(false)} className="hui-btn hui-btn-secondary">Cancel</button>
                                <button type="submit" className="hui-btn hui-btn-primary">{editingType ? 'Save Changes' : 'Create'}</button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}

