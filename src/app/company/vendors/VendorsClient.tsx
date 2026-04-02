"use client";

import { useState, useRef, useEffect } from "react";
import { createVendor, updateVendor, deleteVendor, deleteVendorFile, createVendorTag, updateVendorTag, deleteVendorTag } from "@/lib/actions";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { Plus, Search, MoreHorizontal, Settings, UploadCloud, X, FileText, Check, Trash2, Edit2, Download, Upload, ChevronDown, Tag } from "lucide-react";

export default function VendorsClient({ initialVendors, initialTags }: { initialVendors: any[], initialTags: any[] }) {
    const router = useRouter();
    const [vendors, setVendors] = useState(initialVendors);
    const [tags, setTags] = useState(initialTags);
    const [searchTerm, setSearchTerm] = useState("");
    
    // UI State
    const [isVendorModalOpen, setIsVendorModalOpen] = useState(false);
    const [isTagsModalOpen, setIsTagsModalOpen] = useState(false);
    const [isActionsMenuOpen, setIsActionsMenuOpen] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    
    // Form State
    const [selectedVendor, setSelectedVendor] = useState<any>(null);
    const [formData, setFormData] = useState<any>({});
    const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
    
    // Manage Tags Modal State
    const [tagName, setTagName] = useState("");
    const [editingTagId, setEditingTagId] = useState<string | null>(null);
    const [editingTagName, setEditingTagName] = useState("");

    // List selections and filters
    const [filterStatus, setFilterStatus] = useState<"ACTIVE" | "INACTIVE" | "ALL">("ACTIVE");
    const [filterTagIds, setFilterTagIds] = useState<string[]>([]);
    const [isTagFilterOpen, setIsTagFilterOpen] = useState(false);
    const [rowActionMenuVendorId, setRowActionMenuVendorId] = useState<string | null>(null);
    
    // Sorting
    const [sortField, setSortField] = useState<"name" | "contact" | "date">("name");
    const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
    
    // Ref for closing tag filter dropdown on outside click
    const tagFilterRef = useRef<HTMLDivElement>(null);
    
    // File State (Local files to be uploaded on save, or existing files for edit)
    const [localFiles, setLocalFiles] = useState<File[]>([]);
    const [existingFiles, setExistingFiles] = useState<any[]>([]);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Form Initializer
    const openVendorModal = (vendor?: any) => {
        if (vendor) {
            setSelectedVendor(vendor);
            setFormData({
                name: vendor.name || "",
                website: vendor.website || "",
                description: vendor.description || "",
                firstName: vendor.firstName || "",
                lastName: vendor.lastName || "",
                email: vendor.email || "",
                phone: vendor.phone || "",
                fax: vendor.fax || "",
                address1: vendor.address1 || "",
                address2: vendor.address2 || "",
                city: vendor.city || "",
                state: vendor.state || "",
                zipCode: vendor.zipCode || "",
                country: vendor.country || "",
                paymentTerms: vendor.paymentTerms || "",
                chargesTax: vendor.chargesTax || false,
                accountNumber: vendor.accountNumber || "",
                ein: vendor.ein || "",
                notes: vendor.notes || "",
                status: vendor.status || "ACTIVE",
            });
            setSelectedTagIds(vendor.tags?.map((t:any) => t.id) || []);
            setExistingFiles(vendor.files || []);
            setLocalFiles([]);
        } else {
            setSelectedVendor(null);
            setFormData({ chargesTax: false, status: "ACTIVE" });
            setSelectedTagIds([]);
            setExistingFiles([]);
            setLocalFiles([]);
        }
        setIsVendorModalOpen(true);
    };

    const closeVendorModal = () => {
        setIsVendorModalOpen(false);
        setSelectedVendor(null);
    };

    // Submits the new/edited Vendor via FormData to handle file uploads
    const handleSaveVendor = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!formData.name?.trim()) return toast.error("Company Name is required");
        setIsLoading(true);

        try {
            // First we need to handle file uploads if there are new local files.
            // Ideally we do this by sending everything in a big FormData object to the server.
            // But right now our action takes a JSON object. We will just upload via our generic endpoint or base64.
            // For simplicity in UI, if there are files, we will hit a dedicated route, or base64 encode them for the action.
            
            const uploadedFiles = [];
            if (localFiles.length > 0) {
                // Quick Base64 upload approach for small files, or we could use FormData
                for (const fl of localFiles) {
                    const buffer = await fl.arrayBuffer();
                    const base64 = Buffer.from(buffer).toString('base64');
                    // We'll pass it to a new action, or just use the existing API if possible.
                    // Let's pass it to createVendor/updateVendor and let server actions handle it (we'll need to modify actions to handle base64 if so).
                    // Actually, passing raw ArrayBuffer is supported in modern Server Actions, but let's stick to easy JSON payloads.
                    uploadedFiles.push({
                        name: fl.name,
                        type: fl.type,
                        size: fl.size,
                        base64Data: base64
                    });
                }
            }

            const payload = {
                ...formData,
                tagIds: selectedTagIds,
                filesToUpload: uploadedFiles // We pass this specially
            };

            // Let's use standard JSON, we'll hit `/api/vendors/save` which we will build, or a Next API Route.
            // Actually, we can use the server action directly if we pass Base64!
            // Wait, we didn't add base64 parsing to `actions.ts`. Let's build a quick API route or just do it.
            
            // For now, let's just pass `payload` to an augmented server action we will write next.
            let res;
            if (selectedVendor) {
                const { updateVendorWithFiles } = await import("@/lib/client-actions"); // We will create this
                res = await updateVendorWithFiles(selectedVendor.id, payload);
                toast.success("Vendor updated");
            } else {
                const { createVendorWithFiles } = await import("@/lib/client-actions");
                res = await createVendorWithFiles(payload);
                toast.success("Vendor added");
            }
            
            setVendors(res.vendors); // Expecting action to return fresh list
            closeVendorModal();
            router.refresh();
        } catch (error: any) {
            toast.error(error.message || "Failed to save vendor");
        } finally {
            setIsLoading(false);
        }
    };

    // Close tag filter dropdown on outside click
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (tagFilterRef.current && !tagFilterRef.current.contains(e.target as Node)) {
                setIsTagFilterOpen(false);
            }
        };
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    // Table filtering
    const filtered = vendors.filter(v => {
        const matchesSearch = v.name?.toLowerCase().includes(searchTerm.toLowerCase()) || 
            v.contactName?.toLowerCase().includes(searchTerm.toLowerCase()) ||
            v.email?.toLowerCase().includes(searchTerm.toLowerCase()) ||
            v.firstName?.toLowerCase().includes(searchTerm.toLowerCase()) ||
            v.lastName?.toLowerCase().includes(searchTerm.toLowerCase());
        
        const matchesStatus = filterStatus === "ALL" || (filterStatus === "ACTIVE" ? v.status === "ACTIVE" : v.status !== "ACTIVE");

        const matchesTags = filterTagIds.length === 0 || filterTagIds.some(ftId => 
            v.tags?.some((t: any) => t.id === ftId)
        );

        return matchesSearch && matchesStatus && matchesTags;
    });

    // Sorting
    const sorted = [...filtered].sort((a, b) => {
        const dir = sortDirection === "asc" ? 1 : -1;
        switch (sortField) {
            case "name":
                return dir * (a.name || "").localeCompare(b.name || "");
            case "contact": {
                const aContact = `${a.firstName || ""} ${a.lastName || ""}`.trim();
                const bContact = `${b.firstName || ""} ${b.lastName || ""}`.trim();
                return dir * aContact.localeCompare(bContact);
            }
            case "date":
                return dir * (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
            default:
                return 0;
        }
    });

    const handleSort = (field: "name" | "contact" | "date") => {
        if (sortField === field) {
            setSortDirection(prev => prev === "asc" ? "desc" : "asc");
        } else {
            setSortField(field);
            setSortDirection("asc");
        }
    };

    const toggleTagSelection = (id: string) => {
        setSelectedTagIds(prev => prev.includes(id) ? prev.filter(t => t !== id) : [...prev, id]);
    };

    const toggleFilterTag = (id: string) => {
        setFilterTagIds(prev => prev.includes(id) ? prev.filter(t => t !== id) : [...prev, id]);
    };

    // Export vendors as CSV
    const handleExportCSV = () => {
        const headers = ["Name", "Status", "First Name", "Last Name", "Email", "Phone", "Fax", "Website", "Address", "City", "State", "Zip", "Country", "Payment Terms", "Charges Tax", "Account Number", "EIN", "Tags", "Notes", "Date Added"];
        const rows = filtered.map(v => [
            v.name || "",
            v.status || "",
            v.firstName || "",
            v.lastName || "",
            v.email || "",
            v.phone || "",
            v.fax || "",
            v.website || "",
            [v.address1, v.address2].filter(Boolean).join(" ") || "",
            v.city || "",
            v.state || "",
            v.zipCode || "",
            v.country || "",
            v.paymentTerms || "",
            v.chargesTax ? "Yes" : "No",
            v.accountNumber || "",
            v.ein || "",
            v.tags?.map((t: any) => t.name).join("; ") || "",
            v.notes || "",
            new Date(v.createdAt).toLocaleDateString()
        ]);
        const csvContent = [headers, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `vendors_export_${new Date().toISOString().split('T')[0]}.csv`;
        a.click();
        URL.revokeObjectURL(url);
        toast.success(`Exported ${rows.length} vendor${rows.length !== 1 ? 's' : ''} to CSV`);
        setIsActionsMenuOpen(false);
    };

    // ----- Render Helpers -----
    const renderManageTags = () => {
        // Create a brand new tag from the top input
        const handleCreateTag = async () => {
            if (!tagName.trim()) return;
            try {
                const res = await createVendorTag(tagName);
                setTags([...tags, res]);
                setTagName("");
            } catch(e: any) { toast.error("Error saving tag"); }
        };

        // Save an inline-edited tag
        const handleSaveInlineEdit = async () => {
            if (!editingTagId || !editingTagName.trim()) return;
            try {
                const res = await updateVendorTag(editingTagId, editingTagName);
                setTags(tags.map(t => t.id === res.id ? res : t));
                setEditingTagId(null);
                setEditingTagName("");
            } catch(e: any) { toast.error("Error saving tag"); }
        };

        const handleCancelInlineEdit = () => {
            setEditingTagId(null);
            setEditingTagName("");
        };

        const handleDeleteTag = async (id: string) => {
            try {
                await deleteVendorTag(id);
                setTags(tags.filter(t => t.id !== id));
                if (editingTagId === id) handleCancelInlineEdit();
            } catch(e) { toast.error("Error deleting tag"); }
        };

        return (
            <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/50">
                <div className="bg-white rounded-xl shadow-xl max-w-md w-full max-h-[90vh] flex flex-col">
                    <div className="px-6 py-4 border-b border-hui-border flex justify-between items-center sticky top-0 bg-white z-10">
                        <h2 className="text-xl font-bold text-hui-textMain">Manage Tags</h2>
                        <button onClick={() => { setIsTagsModalOpen(false); handleCancelInlineEdit(); }} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5"/></button>
                    </div>
                    
                    <div className="p-6 flex-1 overflow-y-auto">
                        {/* Top input — always for creating NEW tags */}
                        <div className="flex gap-2 mb-6">
                            <input 
                                type="text" 
                                value={tagName} 
                                onChange={e => setTagName(e.target.value)} 
                                onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); handleCreateTag(); } }}
                                placeholder="New tag name"
                                className="hui-input flex-1"
                            />
                            <button onClick={handleCreateTag} className="hui-btn hui-btn-primary hover:bg-slate-800">
                                <Plus className="w-4 h-4"/>
                            </button>
                        </div>

                        {tags.length === 0 && (
                            <div className="py-6 text-center text-slate-400 text-sm">
                                No tags created yet.
                            </div>
                        )}
                        <ul className="divide-y divide-slate-100 border-t border-slate-100 mt-4">
                            {tags.map(t => (
                                <li key={t.id} className="py-3 flex justify-between items-center group">
                                    {editingTagId === t.id ? (
                                        /* ---- INLINE EDIT MODE ---- */
                                        <div className="flex items-center gap-2 w-full">
                                            <input
                                                type="text"
                                                value={editingTagName}
                                                onChange={e => setEditingTagName(e.target.value)}
                                                onKeyDown={e => {
                                                    if (e.key === "Enter") { e.preventDefault(); handleSaveInlineEdit(); }
                                                    if (e.key === "Escape") handleCancelInlineEdit();
                                                }}
                                                autoFocus
                                                className="hui-input flex-1 text-sm py-1.5"
                                            />
                                            <button onClick={handleSaveInlineEdit} className="hui-btn hui-btn-primary hover:bg-slate-800 px-2 py-1.5">
                                                <Check className="w-4 h-4"/>
                                            </button>
                                            <button onClick={handleCancelInlineEdit} className="hui-btn hui-btn-secondary px-2 py-1.5">
                                                <X className="w-4 h-4"/>
                                            </button>
                                        </div>
                                    ) : (
                                        /* ---- DISPLAY MODE ---- */
                                        <>
                                            <span className="text-sm font-medium text-slate-700">{t.name}</span>
                                            <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                                <button onClick={() => { setEditingTagId(t.id); setEditingTagName(t.name); }} className="text-slate-400 hover:text-hui-primary"><Edit2 className="w-4 h-4"/></button>
                                                <button onClick={() => handleDeleteTag(t.id)} className="text-slate-400 hover:text-red-500"><Trash2 className="w-4 h-4"/></button>
                                            </div>
                                        </>
                                    )}
                                </li>
                            ))}
                        </ul>
                    </div>
                </div>
            </div>
        );
    };

    return (
        <div className="max-w-[1400px] mx-auto pb-20 p-4 sm:p-6">
            {/* Header */}
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-8">
                <div>
                    <h1 className="text-2xl font-bold text-hui-textMain">Vendors</h1>
                </div>
                <div className="flex items-center gap-3">
                    <div className="relative">
                        <button 
                            onClick={() => setIsActionsMenuOpen(!isActionsMenuOpen)}
                            className="text-sm font-semibold flex items-center gap-1 hover:bg-slate-100 px-3 py-2 rounded transition text-slate-700"
                        >
                            Actions <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                        </button>
                        {isActionsMenuOpen && (
                            <div className="absolute right-0 mt-2 w-48 bg-white rounded-lg shadow-lg border border-slate-100 py-1 z-20">
                                <button onClick={handleExportCSV} className="w-full text-left px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 flex items-center gap-2"><Download className="w-3.5 h-3.5"/> Export to CSV</button>
                                <button onClick={() => { setIsActionsMenuOpen(false); setIsTagsModalOpen(true); }} className="w-full text-left px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 flex items-center gap-2"><Tag className="w-3.5 h-3.5"/> Manage Tags</button>
                            </div>
                        )}
                    </div>
                    <button
                        onClick={() => openVendorModal()}
                        className="hui-btn bg-slate-900 border-slate-900 text-white hover:bg-slate-800 flex items-center gap-2 font-bold"
                    >
                        Add Vendor
                    </button>
                </div>
            </div>

            {/* List View */}
            <div className="bg-white rounded-xl shadow-sm border border-hui-border overflow-hidden">
                <div className="p-4 border-b border-hui-border flex items-center gap-4">
                    <div className="relative w-64">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                        <input
                            type="text"
                            placeholder="Search"
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            className="hui-input pl-9 w-full text-sm"
                        />
                    </div>
                    <div className="flex gap-2">
                        {/* Tag Filter Dropdown */}
                        <div className="relative" ref={tagFilterRef}>
                            <button 
                                onClick={() => setIsTagFilterOpen(!isTagFilterOpen)} 
                                className={`hui-btn hui-btn-secondary text-xs h-9 flex items-center gap-1.5 ${
                                    filterTagIds.length > 0 ? 'border-slate-900 bg-slate-900 text-white hover:bg-slate-800' : ''
                                }`}
                            >
                                <Tag className="w-3 h-3"/>
                                Tags {filterTagIds.length > 0 && <span className="bg-white/20 text-white text-[10px] px-1.5 py-0.5 rounded-full font-bold">{filterTagIds.length}</span>}
                                <ChevronDown className="w-3 h-3 ml-0.5"/>
                            </button>
                            {isTagFilterOpen && (
                                <div className="absolute left-0 mt-2 w-56 bg-white rounded-lg shadow-[0_4px_20px_-4px_rgba(0,0,0,0.15)] border border-slate-200 py-1 z-30">
                                    {tags.length === 0 ? (
                                        <div className="px-4 py-3 text-sm text-slate-400">No tags created yet</div>
                                    ) : (
                                        <>
                                            {tags.map(t => (
                                                <button
                                                    key={t.id}
                                                    onClick={() => toggleFilterTag(t.id)}
                                                    className="w-full text-left px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 flex items-center gap-2.5"
                                                >
                                                    <span className={`w-4 h-4 rounded border flex items-center justify-center text-[10px] shrink-0 ${
                                                        filterTagIds.includes(t.id) ? 'bg-slate-900 border-slate-900 text-white' : 'border-slate-300'
                                                    }`}>
                                                        {filterTagIds.includes(t.id) && <Check className="w-3 h-3"/>}
                                                    </span>
                                                    {t.name}
                                                </button>
                                            ))}
                                            {filterTagIds.length > 0 && (
                                                <>
                                                    <div className="border-t border-slate-100 my-1"/>
                                                    <button
                                                        onClick={() => { setFilterTagIds([]); setIsTagFilterOpen(false); }}
                                                        className="w-full text-left px-4 py-2 text-xs text-slate-500 hover:bg-slate-50 font-medium"
                                                    >
                                                        Clear all filters
                                                    </button>
                                                </>
                                            )}
                                        </>
                                    )}
                                </div>
                            )}
                        </div>
                        <select 
                            value={filterStatus}
                            onChange={(e) => setFilterStatus(e.target.value as any)}
                            className="hui-btn hui-btn-secondary text-xs h-9 pl-3 pr-8"
                        >
                            <option value="ACTIVE">Type: Active</option>
                            <option value="INACTIVE">Type: Inactive</option>
                            <option value="ALL">Type: All</option>
                        </select>
                    </div>
                </div>

                <div className="overflow-x-auto min-h-[350px]">
                    <table className="w-full text-left text-sm whitespace-nowrap min-w-max">
                        <thead className="border-b border-hui-border text-xs font-semibold text-slate-500 bg-slate-50/50">
                            <tr>
                                <th className="pl-5 py-3 font-semibold cursor-pointer select-none hover:text-slate-800 transition" onClick={() => handleSort("name")}>
                                    Name <span className={`text-[10px] ${sortField === 'name' ? 'text-slate-800' : 'opacity-50'}`}>{sortField === 'name' ? (sortDirection === 'asc' ? '↑' : '↓') : '↕'}</span>
                                </th>
                                <th className="px-5 py-3 font-semibold cursor-pointer select-none hover:text-slate-800 transition" onClick={() => handleSort("contact")}>
                                    Contact <span className={`text-[10px] ${sortField === 'contact' ? 'text-slate-800' : 'opacity-50'}`}>{sortField === 'contact' ? (sortDirection === 'asc' ? '↑' : '↓') : '↕'}</span>
                                </th>
                                <th className="px-5 py-3 font-semibold">Tags</th>
                                <th className="px-5 py-3 font-semibold">POs</th>
                                <th className="px-5 py-3 font-semibold cursor-pointer select-none hover:text-slate-800 transition" onClick={() => handleSort("date")}>
                                    Date Added <span className={`text-[10px] ${sortField === 'date' ? 'text-slate-800' : 'opacity-50'}`}>{sortField === 'date' ? (sortDirection === 'asc' ? '↑' : '↓') : '↕'}</span>
                                </th>
                                <th className="px-5 py-3"></th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                            {filtered.length === 0 ? (
                                <tr>
                                    <td colSpan={6} className="px-5 py-12 text-center text-slate-400">
                                        No vendors found.
                                    </td>
                                </tr>
                            ) : (
                                sorted.map(v => (
                                    <tr key={v.id} className="hover:bg-slate-50/80 transition group cursor-pointer" onClick={() => openVendorModal(v)}>
                                        <td className="pl-5 py-4 font-semibold text-hui-textMain">
                                            {v.name}
                                            {v.status !== 'ACTIVE' && <span className="ml-2 bg-slate-100 text-slate-500 text-[10px] uppercase px-1.5 py-0.5 rounded">Inactive</span>}
                                        </td>
                                        <td className="px-5 py-4 text-slate-600 flex items-center gap-2">
                                            {(v.firstName || v.lastName) && (
                                                <div className="w-6 h-6 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center text-[10px] font-bold">
                                                    {(v.firstName?.[0] || "")}{(v.lastName?.[0] || "")}
                                                </div>
                                            )}
                                            {v.firstName} {v.lastName}
                                            {v.phone && <span className="text-slate-400 ml-1">{v.phone}</span>}
                                        </td>
                                        <td className="px-5 py-4">
                                            <div className="flex gap-1">
                                                {v.tags?.map((t:any) => (
                                                    <span key={t.id} className="bg-slate-100 text-slate-600 px-2 py-0.5 rounded text-xs border border-slate-200">{t.name}</span>
                                                ))}
                                            </div>
                                        </td>
                                        <td className="px-5 py-4 font-medium text-slate-600">
                                            {v._count?.purchaseOrders > 0 ? (
                                                <span className="flex items-center gap-1.5"><FileText className="w-3.5 h-3.5"/> {v._count.purchaseOrders} PO{v._count.purchaseOrders > 1 ? 's' : ''}</span>
                                            ) : ""}
                                        </td>
                                        <td className="px-5 py-4 text-slate-500">
                                            {new Date(v.createdAt).toLocaleDateString("en-US", {month:"short", day:"numeric", year:"numeric"})}
                                        </td>
                                        <td className="px-5 py-4 text-right relative">
                                            <button 
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    setRowActionMenuVendorId(rowActionMenuVendorId === v.id ? null : v.id);
                                                }} 
                                                className="text-slate-400 hover:text-slate-600 p-1 rounded hover:bg-slate-100"
                                            >
                                                <MoreHorizontal className="w-5 h-5" />
                                            </button>
                                            {rowActionMenuVendorId === v.id && (
                                                <div className="absolute right-5 top-10 mt-1 w-36 bg-white rounded-lg shadow-[0_4px_20px_-4px_rgba(0,0,0,0.15)] border border-slate-200 py-1 z-30" onClick={(e) => e.stopPropagation()}>
                                                    <button onClick={() => { setRowActionMenuVendorId(null); openVendorModal(v); }} className="w-full text-left px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 flex items-center gap-2"><Edit2 className="w-3.5 h-3.5"/> Edit Record</button>
                                                    <button onClick={async () => {
                                                        setRowActionMenuVendorId(null);
                                                        if (confirm("Delete this vendor permanently?")) {
                                                            await deleteVendor(v.id);
                                                            setVendors(vendors.filter(vx => vx.id !== v.id));
                                                            toast.success("Vendor deleted");
                                                            router.refresh();
                                                        }
                                                    }} className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50">Delete Vendor</button>
                                                </div>
                                            )}
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Manage Tags Modal */}
            {isTagsModalOpen && renderManageTags()}

            {/* Create / Edit Vendor Modal */}
            {isVendorModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
                    <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl max-h-[95vh] flex flex-col">
                        <div className="px-8 py-5 border-b border-hui-border flex justify-between items-center bg-white z-10 shrink-0">
                            <h2 className="text-2xl font-bold text-slate-800">
                                {selectedVendor ? 'Edit Vendor' : 'Create New Vendor'}
                            </h2>
                            <button onClick={closeVendorModal} className="text-slate-400 hover:text-slate-600"><X className="w-6 h-6"/></button>
                        </div>
                        
                        <div className="p-8 overflow-y-auto flex-1 bg-white">
                            <form id="vendor-form" onSubmit={handleSaveVendor} className="space-y-10 max-w-2xl">
                                
                                {/* General Details */}
                                <section>
                                    <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wide mb-4">General Details</h3>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                        <div>
                                            <input required type="text" placeholder="Company Name*" value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} className="hui-input w-full" />
                                        </div>
                                        <div>
                                            <input type="text" placeholder="Website" value={formData.website} onChange={e => setFormData({...formData, website: e.target.value})} className="hui-input w-full" />
                                        </div>
                                    </div>
                                    <div className="mt-4">
                                        <textarea placeholder="Description" rows={4} value={formData.description} onChange={e => setFormData({...formData, description: e.target.value})} className="hui-input w-full resize-none" />
                                    </div>
                                    <div className="mt-4 relative">
                                        <div className="p-2 border border-slate-200 rounded-lg min-h-[42px] flex flex-wrap gap-2 items-center cursor-text bg-white">
                                            {selectedTagIds.map(tid => {
                                                const tg = tags.find(x => x.id === tid);
                                                return tg ? (
                                                    <span key={tid} className="bg-slate-100 text-slate-700 px-2 py-1 rounded text-xs flex items-center gap-1 border border-slate-200">
                                                        {tg.name}
                                                        <button type="button" onClick={()=>toggleTagSelection(tid)}><X className="w-3 h-3 hover:text-red-500"/></button>
                                                    </span>
                                                ) : null;
                                            })}
                                            <select 
                                                className="bg-transparent border-0 focus:ring-0 p-0 text-sm text-slate-500 w-full max-w-[150px]"
                                                onChange={e => {
                                                    if (e.target.value && !selectedTagIds.includes(e.target.value)) {
                                                        toggleTagSelection(e.target.value);
                                                    }
                                                    e.target.value = "";
                                                }}
                                            >
                                                <option value="">Search & add tags</option>
                                                {tags.filter(t => !selectedTagIds.includes(t.id)).map(t => (
                                                    <option key={t.id} value={t.id}>{t.name}</option>
                                                ))}
                                            </select>
                                        </div>
                                    </div>
                                </section>

                                {/* Contact Info */}
                                <section>
                                    <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wide mb-4">Contact Info</h3>
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                        <input type="text" placeholder="First Name" value={formData.firstName} onChange={e => setFormData({...formData, firstName: e.target.value})} className="hui-input w-full" />
                                        <input type="text" placeholder="Last Name" value={formData.lastName} onChange={e => setFormData({...formData, lastName: e.target.value})} className="hui-input w-full" />
                                        
                                        <input type="email" placeholder="Email Address" value={formData.email} onChange={e => setFormData({...formData, email: e.target.value})} className="hui-input w-full" />
                                        <div className="grid grid-cols-2 gap-2">
                                            <input type="tel" placeholder="Phone Number" value={formData.phone} onChange={e => setFormData({...formData, phone: e.target.value})} className="hui-input w-full" />
                                            <input type="tel" placeholder="Fax Number" value={formData.fax} onChange={e => setFormData({...formData, fax: e.target.value})} className="hui-input w-full" />
                                        </div>

                                        <input type="text" placeholder="Address Line 1" value={formData.address1} onChange={e => setFormData({...formData, address1: e.target.value})} className="hui-input w-full" />
                                        <input type="text" placeholder="Address Line 2" value={formData.address2} onChange={e => setFormData({...formData, address2: e.target.value})} className="hui-input w-full" />
                                        
                                        <input type="text" placeholder="City" value={formData.city} onChange={e => setFormData({...formData, city: e.target.value})} className="hui-input w-full" />
                                        <input type="text" placeholder="State/Prov" value={formData.state} onChange={e => setFormData({...formData, state: e.target.value})} className="hui-input w-full" />
                                        
                                        <input type="text" placeholder="Zip Code" value={formData.zipCode} onChange={e => setFormData({...formData, zipCode: e.target.value})} className="hui-input w-full" />
                                        <select value={formData.country} onChange={e => setFormData({...formData, country: e.target.value})} className="hui-input w-full text-slate-500">
                                            <option value="">Country</option>
                                            <option value="US">United States</option>
                                            <option value="CA">Canada</option>
                                        </select>
                                    </div>
                                </section>

                                {/* Default Settings */}
                                <section>
                                    <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wide mb-4">Default Settings</h3>
                                    <select value={formData.paymentTerms} onChange={e => setFormData({...formData, paymentTerms: e.target.value})} className="hui-input w-full mb-4 text-slate-500">
                                        <option value="">Default Payment Terms</option>
                                        <option value="Net 15">Net 15</option>
                                        <option value="Net 30">Net 30</option>
                                        <option value="Net 60">Net 60</option>
                                        <option value="Due on Receipt">Due on Receipt</option>
                                    </select>
                                    <label className="flex items-center gap-2 cursor-pointer">
                                        <input type="checkbox" checked={formData.chargesTax} onChange={e => setFormData({...formData, chargesTax: e.target.checked})} className="rounded border-slate-300 text-hui-primary focus:ring-hui-primary w-4 h-4" />
                                        <span className="text-sm text-slate-700 font-medium">Charges Tax</span>
                                    </label>
                                    <label className="flex items-center gap-2 cursor-pointer mt-3">
                                        <input type="checkbox" checked={formData.status === "ACTIVE"} onChange={e => setFormData({...formData, status: e.target.checked ? "ACTIVE" : "INACTIVE"})} className="rounded border-slate-300 text-hui-primary focus:ring-hui-primary w-4 h-4" />
                                        <span className="text-sm text-slate-700 font-medium">Active Vendor</span>
                                    </label>
                                </section>

                                {/* Additional Info */}
                                <section>
                                    <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wide mb-4">Additional Info</h3>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                                        <input type="text" placeholder="Account Number" value={formData.accountNumber} onChange={e => setFormData({...formData, accountNumber: e.target.value})} className="hui-input w-full" />
                                        <input type="text" placeholder="EIN" value={formData.ein} onChange={e => setFormData({...formData, ein: e.target.value})} className="hui-input w-full" />
                                    </div>
                                    <textarea placeholder="Internal Notes" rows={3} value={formData.notes} onChange={e => setFormData({...formData, notes: e.target.value})} className="hui-input w-full resize-none" />
                                </section>

                                {/* Attachments */}
                                <section>
                                    <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wide mb-4">Attachments</h3>
                                    <div 
                                        className="border-2 border-dashed border-slate-300 rounded-xl p-8 text-center hover:bg-slate-50 transition cursor-pointer flex flex-col items-center justify-center gap-2 text-slate-500 font-medium"
                                        onClick={() => fileInputRef.current?.click()}
                                    >
                                        <UploadCloud className="w-6 h-6 text-slate-400" />
                                        <span><span className="text-slate-800 font-bold">Upload Files</span> or drag & drop here</span>
                                        <input 
                                            type="file" 
                                            multiple 
                                            className="hidden" 
                                            ref={fileInputRef} 
                                            onChange={(e) => {
                                                if (e.target.files) {
                                                    setLocalFiles([...localFiles, ...Array.from(e.target.files)]);
                                                }
                                            }} 
                                        />
                                    </div>
                                    
                                    {(localFiles.length > 0 || existingFiles.length > 0) && (
                                        <ul className="mt-4 space-y-2">
                                            {existingFiles.map(f => (
                                                <li key={f.id} className="flex items-center justify-between p-3 bg-slate-50 rounded-lg border border-slate-200">
                                                    <a href={f.url} target="_blank" rel="noreferrer" className="text-sm font-medium text-blue-600 hover:underline flex items-center gap-2 max-w-sm truncate"><FileText className="w-4 h-4 shrink-0"/> {f.name}</a>
                                                    <button type="button" onClick={async () => {
                                                        if (confirm("Delete this file permanently?")) {
                                                            await deleteVendorFile(f.id);
                                                            setExistingFiles(existingFiles.filter(x => x.id !== f.id));
                                                        }
                                                    }} className="text-red-500 hover:bg-red-50 p-1.5 rounded"><Trash2 className="w-4 h-4"/></button>
                                                </li>
                                            ))}
                                            {localFiles.map((f, i) => (
                                                <li key={i} className="flex items-center justify-between p-3 bg-amber-50 rounded-lg border border-amber-200">
                                                    <span className="text-sm font-medium text-amber-800 flex items-center gap-2 max-w-sm truncate"><FileText className="w-4 h-4 shrink-0"/> {f.name} (Pending...)</span>
                                                    <button type="button" onClick={() => {
                                                        setLocalFiles(localFiles.filter((_, idx) => idx !== i));
                                                    }} className="text-amber-600 hover:bg-amber-100 p-1.5 rounded"><X className="w-4 h-4"/></button>
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </section>
                            </form>
                        </div>

                        <div className="p-6 border-t border-hui-border bg-slate-50 shrink-0 flex justify-end gap-3 rounded-b-xl z-10">
                            <button type="button" onClick={closeVendorModal} className="hui-btn bg-white hover:bg-slate-50 border-slate-200 text-slate-700 font-bold px-6">Cancel</button>
                            <button type="button" disabled={isLoading} onClick={async (e) => {
                                e.preventDefault();
                                if (!formData.name?.trim()) return toast.error("Company Name is required");
                                setIsLoading(true);
                                try {
                                    const uploadedFiles = [];
                                    if (localFiles.length > 0) {
                                        for (const fl of localFiles) {
                                            const buffer = await fl.arrayBuffer();
                                            const base64 = Buffer.from(buffer).toString('base64');
                                            uploadedFiles.push({ name: fl.name, type: fl.type, size: fl.size, base64Data: base64 });
                                        }
                                    }
                                    const payload = { ...formData, tagIds: selectedTagIds, filesToUpload: uploadedFiles };
                                    if (selectedVendor) {
                                        const { updateVendorWithFiles } = await import("@/lib/client-actions");
                                        const res = await updateVendorWithFiles(selectedVendor.id, payload);
                                        setVendors(res.vendors);
                                        toast.success("Vendor updated");
                                    } else {
                                        const { createVendorWithFiles } = await import("@/lib/client-actions");
                                        const res = await createVendorWithFiles(payload);
                                        setVendors(res.vendors);
                                        toast.success("Vendor added");
                                    }
                                    // Reset form for a new vendor
                                    setSelectedVendor(null);
                                    setFormData({ chargesTax: false, status: "ACTIVE" });
                                    setSelectedTagIds([]);
                                    setExistingFiles([]);
                                    setLocalFiles([]);
                                    router.refresh();
                                } catch (error: any) {
                                    toast.error(error.message || "Failed to save vendor");
                                } finally {
                                    setIsLoading(false);
                                }
                            }} className="hui-btn bg-white hover:bg-slate-50 border-slate-200 text-slate-700 font-bold px-6 disabled:opacity-50">Save & Add New</button>
                            <button type="submit" form="vendor-form" disabled={isLoading} className="hui-btn bg-slate-900 border-slate-900 text-white hover:bg-slate-800 px-8 font-bold disabled:opacity-50">
                                {isLoading ? 'Saving...' : 'Save'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
