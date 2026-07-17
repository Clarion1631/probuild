"use client";

import { useState, useEffect } from "react";
import { getVendors, createVendor, quickCreatePOAndLink } from "@/lib/actions";
import { formatCurrency } from "@/lib/utils";
import { toast } from "sonner";
import { useRouter } from "next/navigation";

interface POQuickCreateModalProps {
    estimateItemId: string;
    suggestedAmount: number | null;
    projectId: string;
    onClose: () => void;
    onCreated: (po: any) => void;
}

export default function POQuickCreateModal({
    estimateItemId, suggestedAmount, projectId, onClose, onCreated
}: POQuickCreateModalProps) {
    const router = useRouter();
    const [vendors, setVendors] = useState<any[]>([]);
    const [fetching, setFetching] = useState(true);
    const [search, setSearch] = useState("");
    const [selectedVendorId, setSelectedVendorId] = useState("");
    const [amount, setAmount] = useState(suggestedAmount != null ? suggestedAmount.toString() : "");
    const [notes, setNotes] = useState("");
    const [isCreating, setIsCreating] = useState(false);

    // New vendor inline form
    const [showNewVendor, setShowNewVendor] = useState(false);
    const [newName, setNewName] = useState("");
    const [newEmail, setNewEmail] = useState("");
    const [newPhone, setNewPhone] = useState("");
    const [isSavingVendor, setIsSavingVendor] = useState(false);

    useEffect(() => {
        getVendors().then(data => {
            setVendors(data);
            setFetching(false);
        }).catch(() => {
            toast.error("Failed to load vendors");
            setFetching(false);
        });
    }, []);

    const filtered = vendors.filter(v =>
        v.status === "ACTIVE" && (!search || v.name.toLowerCase().includes(search.toLowerCase()))
    );

    async function handleCreateVendor() {
        if (!newName.trim()) { toast.error("Vendor name is required"); return; }
        setIsSavingVendor(true);
        try {
            const vendor = await createVendor({ name: newName.trim(), email: newEmail.trim() || null, phone: newPhone.trim() || null });
            setVendors([...vendors, vendor]);
            setSelectedVendorId(vendor.id);
            setShowNewVendor(false);
            setNewName(""); setNewEmail(""); setNewPhone("");
            toast.success(`Vendor "${vendor.name}" created`);
        } catch (err: any) {
            toast.error(err.message || "Failed to create vendor");
        } finally {
            setIsSavingVendor(false);
        }
    }

    async function handleCreate(openEditor: boolean) {
        if (!selectedVendorId) { toast.error("Select a vendor"); return; }
        if (!amount || parseFloat(amount) <= 0) { toast.error("Enter a valid amount"); return; }
        setIsCreating(true);
        try {
            const po = await quickCreatePOAndLink(estimateItemId, {
                vendorId: selectedVendorId,
                amount: parseFloat(amount),
                notes: notes.trim() || undefined,
            });
            toast.success(`${po.code} created and linked`);
            onCreated(po);
            onClose();
            if (openEditor) {
                window.open(`/projects/${projectId}/purchase-orders/${po.id}`, "_blank");
            }
        } catch (err: any) {
            toast.error(err.message || "Failed to create PO");
        } finally {
            setIsCreating(false);
        }
    }

    const selectedVendor = vendors.find(v => v.id === selectedVendorId);

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm">
            <div className="bg-white rounded-xl shadow-xl border border-slate-200 w-full max-w-md overflow-hidden flex flex-col max-h-[80vh]">
                {/* Header */}
                <div className="px-6 py-4 border-b border-slate-100 flex justify-between items-center bg-slate-50">
                    <h3 className="font-bold text-lg text-slate-800">Quick Create PO</h3>
                    <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
                    </button>
                </div>

                {/* Body */}
                <div className="p-6 space-y-4 overflow-y-auto">
                    {/* Vendor Selection */}
                    <div className="space-y-1.5">
                        <label className="text-sm font-medium text-slate-700">Vendor *</label>
                        {selectedVendor ? (
                            <div className="flex items-center justify-between bg-indigo-50 border border-indigo-200 rounded px-3 py-2">
                                <span className="text-sm font-medium text-indigo-800">{selectedVendor.name}</span>
                                <button onClick={() => setSelectedVendorId("")} className="text-indigo-400 hover:text-indigo-600 text-xs">Change</button>
                            </div>
                        ) : (
                            <>
                                <input
                                    type="text"
                                    value={search}
                                    onChange={e => setSearch(e.target.value)}
                                    className="w-full border border-slate-300 rounded px-3 py-2 text-sm focus:ring-2 ring-indigo-500 focus:outline-none"
                                    placeholder={fetching ? "Loading vendors..." : "Search vendors..."}
                                />
                                {!fetching && (
                                    <div className="max-h-32 overflow-y-auto border border-slate-200 rounded divide-y divide-slate-50">
                                        {filtered.map(v => (
                                            <button
                                                key={v.id}
                                                onClick={() => { setSelectedVendorId(v.id); setSearch(""); }}
                                                className="w-full text-left px-3 py-2 text-sm hover:bg-indigo-50 transition"
                                            >
                                                {v.name} {v.type && <span className="text-slate-400 text-xs">({v.type})</span>}
                                            </button>
                                        ))}
                                        {filtered.length === 0 && (
                                            <div className="px-3 py-2 text-sm text-slate-400">No vendors found</div>
                                        )}
                                    </div>
                                )}
                                <button
                                    onClick={() => setShowNewVendor(!showNewVendor)}
                                    className="text-xs text-indigo-500 hover:text-indigo-700 font-medium"
                                >
                                    + New Vendor
                                </button>
                            </>
                        )}
                    </div>

                    {/* Inline New Vendor Form */}
                    {showNewVendor && (
                        <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-2">
                            <input type="text" value={newName} onChange={e => setNewName(e.target.value)} className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm focus:ring-1 ring-indigo-400 focus:outline-none" placeholder="Vendor name *" />
                            <div className="grid grid-cols-2 gap-2">
                                <input type="email" value={newEmail} onChange={e => setNewEmail(e.target.value)} className="border border-slate-300 rounded px-2 py-1.5 text-sm focus:ring-1 ring-indigo-400 focus:outline-none" placeholder="Email" />
                                <input type="tel" value={newPhone} onChange={e => setNewPhone(e.target.value)} className="border border-slate-300 rounded px-2 py-1.5 text-sm focus:ring-1 ring-indigo-400 focus:outline-none" placeholder="Phone" />
                            </div>
                            <button onClick={handleCreateVendor} disabled={isSavingVendor} className="hui-btn hui-btn-primary text-xs py-1 disabled:opacity-50">
                                {isSavingVendor ? "Saving..." : "Save Vendor"}
                            </button>
                        </div>
                    )}

                    {/* Amount */}
                    <div className="space-y-1.5">
                        <label className="text-sm font-medium text-slate-700">Amount *</label>
                        <div className="relative">
                            <span className="absolute left-3 top-2 text-slate-400">$</span>
                            <input
                                type="number"
                                value={amount}
                                onChange={e => setAmount(e.target.value)}
                                className="w-full border border-slate-300 rounded pl-7 pr-3 py-2 text-sm focus:ring-2 ring-indigo-500 focus:outline-none"
                                placeholder="0.00"
                                step="0.01"
                            />
                        </div>
                        {suggestedAmount != null && (
                            <p className="text-[10px] text-slate-400">Suggested from internal budget: {formatCurrency(suggestedAmount)}</p>
                        )}
                    </div>

                    {/* Notes */}
                    <div className="space-y-1.5">
                        <label className="text-sm font-medium text-slate-700">Notes</label>
                        <input
                            type="text"
                            value={notes}
                            onChange={e => setNotes(e.target.value)}
                            className="w-full border border-slate-300 rounded px-3 py-2 text-sm focus:ring-2 ring-indigo-500 focus:outline-none"
                            placeholder="Optional notes..."
                        />
                    </div>
                </div>

                {/* Footer */}
                <div className="px-6 py-4 border-t border-slate-100 flex justify-between items-center bg-slate-50">
                    <button onClick={onClose} className="hui-btn hui-btn-secondary text-sm">Cancel</button>
                    <div className="flex gap-2">
                        <button
                            onClick={() => handleCreate(true)}
                            disabled={isCreating}
                            className="hui-btn hui-btn-secondary text-sm disabled:opacity-50"
                        >
                            Open Full Editor →
                        </button>
                        <button
                            onClick={() => handleCreate(false)}
                            disabled={isCreating}
                            className="hui-btn hui-btn-primary text-sm disabled:opacity-50"
                        >
                            {isCreating ? "Creating..." : "Create & Link"}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
