"use client";

import { useState } from "react";
import { createVendor, updateVendor, deleteVendor } from "@/lib/actions";
import { toast } from "sonner";
import { useRouter } from "next/navigation";

export default function VendorsClient({ initialVendors }: { initialVendors: any[] }) {
    const router = useRouter();
    const [vendors, setVendors] = useState(initialVendors);
    const [searchTerm, setSearchTerm] = useState("");
    const [isMenuOpen, setIsMenuOpen] = useState(false);
    const [selectedVendor, setSelectedVendor] = useState<any>(null);
    const [isLoading, setIsLoading] = useState(false);

    // Form inputs
    const [name, setName] = useState("");
    const [contactName, setContactName] = useState("");
    const [email, setEmail] = useState("");
    const [phone, setPhone] = useState("");
    const [address, setAddress] = useState("");
    const [notes, setNotes] = useState("");

    const openModal = (vendor?: any) => {
        if (vendor) {
            setSelectedVendor(vendor);
            setName(vendor.name);
            setContactName(vendor.contactName || "");
            setEmail(vendor.email || "");
            setPhone(vendor.phone || "");
            setAddress(vendor.address || "");
            setNotes(vendor.notes || "");
        } else {
            setSelectedVendor(null);
            setName("");
            setContactName("");
            setEmail("");
            setPhone("");
            setAddress("");
            setNotes("");
        }
        setIsMenuOpen(true);
    };

    const closeModal = () => {
        setIsMenuOpen(false);
        setSelectedVendor(null);
    };

    const handleSave = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!name.trim()) return toast.error("Vendor name is required");
        setIsLoading(true);

        const data = { name, contactName, email, phone, address, notes };

        try {
            if (selectedVendor) {
                await updateVendor(selectedVendor.id, data);
                toast.success("Vendor updated");
            } else {
                await createVendor(data);
                toast.success("Vendor added");
            }
            router.refresh(); // Rely on server component to fetch fresh data
            // Also optimistically update locally to avoid waiting
            const newVendors = selectedVendor 
                ? vendors.map(v => v.id === selectedVendor.id ? { ...v, ...data } : v)
                : [...vendors, { id: Math.random().toString(), ...data, createdAt: new Date() }];
            
            setVendors(newVendors as any);
            closeModal();
        } catch (error: any) {
            toast.error(error.message || "Failed to save vendor");
        } finally {
            setIsLoading(false);
        }
    };

    const handleDelete = async (id: string, name: string) => {
        if (!confirm(`Are you sure you want to delete ${name}? This action cannot be undone.`)) return;
        setIsLoading(true);
        try {
            await deleteVendor(id);
            toast.success("Vendor deleted");
            setVendors(vendors.filter(v => v.id !== id));
            router.refresh();
        } catch (error: any) {
            toast.error(error.message || "Failed to delete vendor");
        } finally {
            setIsLoading(false);
        }
    };

    const filtered = vendors.filter(v => 
        v.name.toLowerCase().includes(searchTerm.toLowerCase()) || 
        v.contactName?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        v.email?.toLowerCase().includes(searchTerm.toLowerCase())
    );

    return (
        <div className="max-w-7xl mx-auto pb-20">
            {/* Header */}
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-8">
                <div>
                    <h1 className="text-2xl font-bold text-hui-textMain">Vendors</h1>
                    <p className="text-sm text-hui-textLight">Manage suppliers and vendors used for purchase orders.</p>
                </div>
                <button
                    onClick={() => openModal()}
                    className="hui-btn hui-btn-primary flex items-center gap-2"
                >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                    Add Vendor
                </button>
            </div>

            {/* List View */}
            <div className="bg-white rounded-xl shadow-sm border border-hui-border overflow-hidden">
                <div className="p-4 border-b border-hui-border bg-slate-50 flex items-center gap-4">
                    <div className="relative flex-1 max-w-md">
                        <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                        <input
                            type="text"
                            placeholder="Search vendors..."
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            className="hui-input pl-9 w-full text-sm"
                        />
                    </div>
                </div>

                <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm text-hui-textMain">
                        <thead className="bg-slate-50 border-b border-hui-border text-[11px] uppercase text-hui-textMuted tracking-wider">
                            <tr>
                                <th className="px-5 py-3 font-semibold">Vendor Name</th>
                                <th className="px-5 py-3 font-semibold">Contact</th>
                                <th className="px-5 py-3 font-semibold">Email</th>
                                <th className="px-5 py-3 font-semibold">Phone</th>
                                <th className="px-5 py-3 font-semibold text-right">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 bg-white">
                            {filtered.length === 0 ? (
                                <tr>
                                    <td colSpan={5} className="px-5 py-8 text-center text-slate-400">
                                        No vendors found.
                                    </td>
                                </tr>
                            ) : (
                                filtered.map(v => (
                                    <tr key={v.id} className="hover:bg-slate-50/50 transition">
                                        <td className="px-5 py-4 font-medium">{v.name}</td>
                                        <td className="px-5 py-4 text-slate-600">{v.contactName || "-"}</td>
                                        <td className="px-5 py-4">
                                            {v.email ? (
                                                <a href={`mailto:${v.email}`} className="text-hui-primary hover:underline">{v.email}</a>
                                            ) : "-"}
                                        </td>
                                        <td className="px-5 py-4 text-slate-600">{v.phone || "-"}</td>
                                        <td className="px-5 py-4">
                                            <div className="flex justify-end items-center gap-3">
                                                <button onClick={() => openModal(v)} className="text-slate-400 hover:text-hui-primary font-medium text-xs uppercase tracking-wider">Edit</button>
                                                <button onClick={() => handleDelete(v.id, v.name)} className="text-slate-400 hover:text-red-500 font-medium text-xs uppercase tracking-wider">Delete</button>
                                            </div>
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Manage Vendor Modal */}
            {isMenuOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
                    <div className="bg-white rounded-xl shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
                        <div className="px-6 py-4 border-b border-hui-border flex justify-between items-center sticky top-0 bg-white z-10">
                            <h2 className="text-lg font-bold text-hui-textMain">
                                {selectedVendor ? 'Edit Vendor' : 'Add New Vendor'}
                            </h2>
                            <button onClick={closeModal} className="text-slate-400 hover:text-slate-600 text-2xl font-light">&times;</button>
                        </div>
                        
                        <form onSubmit={handleSave} className="p-6 space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-slate-700 mb-1">Company Name *</label>
                                <input required type="text" value={name} onChange={e => setName(e.target.value)} className="hui-input w-full" placeholder="e.g. Home Depot Pro" />
                            </div>
                            
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-sm font-medium text-slate-700 mb-1">Contact Name</label>
                                    <input type="text" value={contactName} onChange={e => setContactName(e.target.value)} className="hui-input w-full" />
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-slate-700 mb-1">Phone</label>
                                    <input type="tel" value={phone} onChange={e => setPhone(e.target.value)} className="hui-input w-full" />
                                </div>
                            </div>

                            <div>
                                <label className="block text-sm font-medium text-slate-700 mb-1">Email</label>
                                <input type="email" value={email} onChange={e => setEmail(e.target.value)} className="hui-input w-full" />
                            </div>

                            <div>
                                <label className="block text-sm font-medium text-slate-700 mb-1">Address</label>
                                <input type="text" value={address} onChange={e => setAddress(e.target.value)} className="hui-input w-full" />
                            </div>

                            <div>
                                <label className="block text-sm font-medium text-slate-700 mb-1">Internal Notes</label>
                                <textarea value={notes} onChange={e => setNotes(e.target.value)} className="hui-input w-full p-2 h-24 text-sm" placeholder="Terms, account num, etc." />
                            </div>
                            
                            <div className="pt-4 flex justify-end gap-3 border-t border-hui-border mt-6">
                                <button type="button" onClick={closeModal} className="hui-btn hui-btn-secondary">Cancel</button>
                                <button type="submit" disabled={isLoading} className="hui-btn hui-btn-primary disabled:opacity-50">
                                    {isLoading ? 'Saving...' : 'Save Vendor'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}
