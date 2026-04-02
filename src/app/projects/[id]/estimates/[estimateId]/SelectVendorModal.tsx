"use client";

import { useState, useEffect } from "react";
import { getVendors, createVendor } from "@/lib/actions";
import { toast } from "sonner";

interface SelectVendorModalProps {
    onSelect: (vendorId: string) => void;
    onClose: () => void;
}

export default function SelectVendorModal({ onSelect, onClose }: SelectVendorModalProps) {
    const [vendors, setVendors] = useState<any[]>([]);
    const [fetching, setFetching] = useState(true);
    const [search, setSearch] = useState("");
    const [statusFilter, setStatusFilter] = useState("ACTIVE"); // ACTIVE, INACTIVE, ALL
    const [isCreating, setIsCreating] = useState(false);
    
    // New vendor form state
    const [newName, setNewName] = useState("");
    const [newEmail, setNewEmail] = useState("");
    const [newType, setNewType] = useState("");
    const [isSaving, setIsSaving] = useState(false);

    useEffect(() => {
        getVendors().then(data => {
            setVendors(data);
            setFetching(false);
        }).catch(err => {
            toast.error("Failed to fetch vendors");
            setFetching(false);
        });
    }, []);

    const filteredVendors = vendors.filter(v => {
        if (statusFilter !== "ALL" && v.status !== statusFilter) return false;
        if (search) {
            const q = search.toLowerCase();
            return v.name.toLowerCase().includes(q) || (v.type && v.type.toLowerCase().includes(q));
        }
        return true;
    });

    const handleCreateVendor = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newName.trim() || !newEmail.trim()) {
            toast.error("Name and Email are required");
            return;
        }
        setIsSaving(true);
        try {
            const newVendor = await createVendor({
                name: newName,
                email: newEmail,
                type: newType,
                status: "ACTIVE"
            });
            toast.success("Vendor created successfully");
            setVendors([newVendor, ...vendors]);
            setIsCreating(false);
            onSelect(newVendor.id);
        } catch (err: any) {
            toast.error(err.message || "Failed to create vendor");
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6">
            <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" onClick={onClose} />
            
            <div className="relative w-full max-w-2xl bg-white rounded-2xl shadow-2xl flex flex-col max-h-[85vh] overflow-hidden animate-in fade-in zoom-in-95 duration-200">
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-hui-border bg-slate-50/50">
                    <h2 className="text-xl font-bold text-hui-textMain flex items-center gap-2">
                        <svg className="w-5 h-5 text-hui-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" /></svg>
                        {isCreating ? "Create New Vendor" : "Select a Vendor"}
                    </h2>
                    <button onClick={onClose} className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-full transition">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                </div>

                {isCreating ? (
                    /* Create Vendor View */
                    <form onSubmit={handleCreateVendor} className="p-6 overflow-y-auto">
                        <div className="space-y-4">
                            <div>
                                <label className="block text-sm font-semibold text-slate-700 mb-1">Vendor Name <span className="text-red-500">*</span></label>
                                <input required type="text" value={newName} onChange={e => setNewName(e.target.value)} className="hui-input w-full" placeholder="e.g. Acme Corp" />
                            </div>
                            <div>
                                <label className="block text-sm font-semibold text-slate-700 mb-1">Email <span className="text-red-500">*</span></label>
                                <input required type="email" value={newEmail} onChange={e => setNewEmail(e.target.value)} className="hui-input w-full" placeholder="contact@acme.com" />
                            </div>
                            <div>
                                <label className="block text-sm font-semibold text-slate-700 mb-1">Type / Trade</label>
                                <input type="text" value={newType} onChange={e => setNewType(e.target.value)} className="hui-input w-full" placeholder="e.g. Supplier, Lumber" />
                            </div>
                        </div>

                        <div className="mt-8 flex justify-end gap-3 pt-4 border-t border-slate-100">
                            <button type="button" onClick={() => setIsCreating(false)} className="hui-btn hui-btn-secondary">Back to List</button>
                            <button type="submit" disabled={isSaving} className="hui-btn hui-btn-primary min-w-[120px]">
                                {isSaving ? "Saving..." : "Create & Select"}
                            </button>
                        </div>
                    </form>
                ) : (
                    /* Vendor List View */
                    <div className="flex flex-col h-full overflow-hidden">
                        {/* Filters */}
                        <div className="p-4 border-b border-slate-100 flex flex-col sm:flex-row gap-3">
                            <div className="relative flex-1">
                                <svg className="w-4 h-4 absolute left-3 top-3 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                                <input 
                                    type="text" 
                                    className="hui-input pl-9 w-full text-sm py-2" 
                                    placeholder="Search by name or type..." 
                                    value={search}
                                    onChange={e => setSearch(e.target.value)}
                                />
                            </div>
                            <select 
                                value={statusFilter}
                                onChange={e => setStatusFilter(e.target.value)}
                                className="hui-input text-sm py-2 bg-slate-50"
                            >
                                <option value="ALL">All Status</option>
                                <option value="ACTIVE">Active Only</option>
                                <option value="INACTIVE">Inactive Only</option>
                            </select>
                            <button onClick={() => setIsCreating(true)} className="hui-btn hui-btn-secondary py-2 text-sm whitespace-nowrap">
                                + New Vendor
                            </button>
                        </div>

                        {/* List */}
                        <div className="overflow-y-auto p-4 flex-1 min-h-[300px]">
                            {fetching ? (
                                <div className="flex items-center justify-center h-40 text-slate-400">Loading...</div>
                            ) : filteredVendors.length === 0 ? (
                                <div className="flex flex-col items-center justify-center h-40 text-slate-500 gap-3">
                                    <p>No vendors found.</p>
                                    <button onClick={() => setIsCreating(true)} className="hui-btn hui-btn-secondary text-sm">Create New Vendor</button>
                                </div>
                            ) : (
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                    {filteredVendors.map(v => (
                                        <div 
                                            key={v.id} 
                                            onClick={() => onSelect(v.id)}
                                            className="group cursor-pointer border border-hui-border rounded-xl p-4 hover:border-hui-primary hover:shadow-md transition bg-white"
                                        >
                                            <div className="flex justify-between items-start mb-1">
                                                <h3 className="font-bold text-hui-textMain group-hover:text-hui-primary transition line-clamp-1">{v.name}</h3>
                                                {v.status === 'INACTIVE' && (
                                                    <span className="text-[10px] bg-slate-100 text-slate-500 font-bold px-2 py-0.5 rounded-full uppercase tracking-wider">Inactive</span>
                                                )}
                                            </div>
                                            {(v.type || v.email) && (
                                                <div className="text-xs text-slate-500 space-y-0.5">
                                                    {v.type && <p>{v.type}</p>}
                                                    {v.email && <p className="truncate text-slate-400">{v.email}</p>}
                                                </div>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
