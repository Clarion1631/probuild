"use client";
import { useState, useEffect, use, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import TradeTagSelector from "@/components/TradeTagSelector";
import { uploadSubcontractorCOI } from "@/lib/actions";
import ProjectAccessManager from "./ProjectAccessManager";

interface TaskAssignment {
    taskId: string;
    task: { name: string; project: { name: string } };
}

interface Subcontractor {
    id: string;
    companyName: string;
    contactName: string | null;
    email: string;
    phone: string | null;
    trade: string | null;
    licenseNumber: string | null;
    status: string;
    coiFileUrl: string | null;
    coiExpiresAt: string | null;
    coiUploaded: boolean;
    firstName: string | null;
    lastName: string | null;
    website: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
    country: string | null;
    internalNotes: string | null;
    taskAssignments: TaskAssignment[];
}

export default function SubcontractorDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = use(params);
    const router = useRouter();
    const [sub, setSub] = useState<Subcontractor | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [inviting, setInviting] = useState(false);
    const [uploadingCoi, setUploadingCoi] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    
    // Form state
    const [form, setForm] = useState({
        companyName: "",
        firstName: "",
        lastName: "",
        website: "",
        email: "",
        phone: "",
        addressLine1: "",
        addressLine2: "",
        city: "",
        state: "",
        zip: "",
        country: "United States",
        trade: "",
        internalNotes: "",
        licenseNumber: "",
        status: "",
    });

    useEffect(() => {
        fetchSub();
    }, [id]);

    async function fetchSub() {
        const res = await fetch(`/api/subcontractors/${id}`);
        if (!res.ok) {
            toast.error("Subcontractor not found");
            router.push("/company/subcontractors");
            return;
        }
        const data = await res.json();
        setSub(data);
        setForm({
            companyName: data.companyName || "",
            firstName: data.firstName || "",
            lastName: data.lastName || "",
            website: data.website || "",
            email: data.email || "",
            phone: data.phone || "",
            addressLine1: data.addressLine1 || "",
            addressLine2: data.addressLine2 || "",
            city: data.city || "",
            state: data.state || "",
            zip: data.zip || "",
            country: data.country || "United States",
            trade: data.trade || "",
            internalNotes: data.internalNotes || "",
            licenseNumber: data.licenseNumber || "",
            status: data.status || "ACTIVE",
        });
        setLoading(false);
    }

    async function handleSave() {
        setSaving(true);
        try {
            const res = await fetch(`/api/subcontractors/${id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(form)
            });
            if (!res.ok) throw new Error("Failed to save");
            toast.success("Saved subcontractor details");
            fetchSub(); // refresh data
        } catch {
            toast.error("Failed to save changes");
        } finally {
            setSaving(false);
        }
    }

    async function handleDelete() {
        if (!confirm("Are you sure you want to delete this subcontractor? This cannot be undone.")) return;
        try {
            const res = await fetch(`/api/subcontractors/${id}`, { method: "DELETE" });
            if (!res.ok) throw new Error("Failed to delete");
            toast.success("Subcontractor deleted");
            router.push("/company/subcontractors");
        } catch {
            toast.error("Failed to delete subcontractor");
        }
    }

    async function handleInviteToPortal() {
        if (!sub?.email) {
            toast.error("Subcontractor must have an email address");
            return;
        }
        setInviting(true);
        try {
            const res = await fetch("/api/sub-portal/login", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email: sub.email })
            });
            if (!res.ok) throw new Error("Failed to send invite");
            toast.success(`Portal login link sent to ${sub.email}`);
        } catch {
            toast.error("Failed to send portal invite");
        } finally {
            setInviting(false);
        }
    }

    async function handleUploadCOI(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        if (!file) return;

        setUploadingCoi(true);
        try {
            const formData = new FormData();
            formData.append("file", file);
            
            await uploadSubcontractorCOI(id, formData);
            
            // Overwrite local sub so UI updates to show compliant
            setSub(prev => prev ? { ...prev, coiUploaded: true } : prev);
            toast.success("Certificate of Insurance uploaded successfully");
        } catch (error: any) {
            toast.error(error.message || "Upload failed");
        } finally {
            setUploadingCoi(false);
            if (fileInputRef.current) fileInputRef.current.value = "";
        }
    }

    if (loading) return <div className="p-8 text-slate-500">Loading...</div>;
    if (!sub) return null;

    return (
        <div className="flex-1 p-6 md:p-8 max-w-5xl">
            {/* Header */}
            <div className="flex items-center gap-4 mb-8">
                <Link href="/company/subcontractors" className="p-2 hover:bg-slate-100 rounded-full transition text-slate-400 hover:text-hui-primary">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                </Link>
                <div>
                    <h1 className="text-2xl font-bold text-hui-textMain">Edit Subcontractor</h1>
                    <p className="text-sm text-slate-500 mt-1">{sub.companyName}</p>
                </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                {/* Left Column: Details Form */}
                <div className="lg:col-span-2 space-y-6">
                    <div className="bg-white rounded-xl shadow-sm border border-hui-border p-6">
                        <h2 className="text-sm font-bold text-hui-textMain uppercase tracking-wider mb-5">Contact Info</h2>
                        <div className="grid grid-cols-2 gap-5 mb-5">
                            <div>
                                <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1 block">First Name</label>
                                <input type="text" value={form.firstName} onChange={e => setForm(f => ({ ...f, firstName: e.target.value }))}
                                    className="w-full border border-hui-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-hui-primary/20"
                                />
                            </div>
                            <div>
                                <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1 block">Last Name</label>
                                <input type="text" value={form.lastName} onChange={e => setForm(f => ({ ...f, lastName: e.target.value }))}
                                    className="w-full border border-hui-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-hui-primary/20"
                                />
                            </div>
                        </div>

                        <div className="grid grid-cols-2 gap-5 mb-5">
                            <div>
                                <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1 block">Company</label>
                                <input type="text" value={form.companyName} onChange={e => setForm(f => ({ ...f, companyName: e.target.value }))}
                                    className="w-full border border-hui-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-hui-primary/20"
                                />
                            </div>
                            <div>
                                <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1 block">Website</label>
                                <input type="text" value={form.website} onChange={e => setForm(f => ({ ...f, website: e.target.value }))}
                                    className="w-full border border-hui-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-hui-primary/20"
                                />
                            </div>
                        </div>

                        <div className="grid grid-cols-2 gap-5 mb-8">
                            <div>
                                <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1 block">Email</label>
                                <input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                                    className="w-full border border-hui-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-hui-primary/20"
                                />
                            </div>
                            <div>
                                <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1 block">Phone Number</label>
                                <input type="tel" value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                                    className="w-full border border-hui-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-hui-primary/20"
                                />
                            </div>
                        </div>

                        <h2 className="text-sm font-bold text-hui-textMain uppercase tracking-wider mb-5 border-t border-slate-100 pt-6">General Details</h2>
                        
                        <div className="grid grid-cols-2 gap-5 mb-5">
                            <div>
                                <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1 block">Address Line 1</label>
                                <input type="text" value={form.addressLine1} onChange={e => setForm(f => ({ ...f, addressLine1: e.target.value }))}
                                    className="w-full border border-hui-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-hui-primary/20"
                                />
                            </div>
                            <div>
                                <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1 block">Address Line 2</label>
                                <input type="text" value={form.addressLine2} onChange={e => setForm(f => ({ ...f, addressLine2: e.target.value }))}
                                    className="w-full border border-hui-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-hui-primary/20"
                                />
                            </div>
                        </div>

                        <div className="grid grid-cols-2 gap-5 mb-5">
                            <div>
                                <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1 block">City</label>
                                <input type="text" value={form.city} onChange={e => setForm(f => ({ ...f, city: e.target.value }))}
                                    className="w-full border border-hui-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-hui-primary/20"
                                />
                            </div>
                            <div>
                                <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1 block">State</label>
                                <input type="text" value={form.state} onChange={e => setForm(f => ({ ...f, state: e.target.value }))}
                                    className="w-full border border-hui-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-hui-primary/20"
                                />
                            </div>
                        </div>

                        <div className="grid grid-cols-2 gap-5 mb-5">
                            <div>
                                <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1 block">Zip Code</label>
                                <input type="text" value={form.zip} onChange={e => setForm(f => ({ ...f, zip: e.target.value }))}
                                    className="w-full border border-hui-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-hui-primary/20"
                                />
                            </div>
                            <div>
                                <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1 block">Country</label>
                                <select value={form.country} onChange={e => setForm(f => ({ ...f, country: e.target.value }))}
                                    className="w-full border border-hui-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-hui-primary/20"
                                >
                                    <option value="United States">United States</option>
                                    <option value="Canada">Canada</option>
                                    <option value="Other">Other</option>
                                </select>
                            </div>
                        </div>

                        <div className="mb-5">
                            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1 block">Trade / Specialty</label>
                            <TradeTagSelector 
                                value={form.trade || ""} 
                                onChange={(val) => setForm(f => ({ ...f, trade: val }))}
                            />
                        </div>

                        <div className="mb-6">
                            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1 block">Internal Notes</label>
                            <textarea 
                                value={form.internalNotes} 
                                onChange={e => setForm(f => ({ ...f, internalNotes: e.target.value }))}
                                rows={3}
                                className="w-full border border-hui-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-hui-primary/20 resize-y"
                            ></textarea>
                        </div>
                        
                        <div className="grid grid-cols-2 gap-5 pt-4 border-t border-slate-100">
                            <div>
                                <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1 block">License Number</label>
                                <input type="text" value={form.licenseNumber} onChange={e => setForm(f => ({ ...f, licenseNumber: e.target.value }))}
                                    className="w-full border border-hui-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-hui-primary/20"
                                />
                            </div>
                            <div>
                                <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1 block">Status</label>
                                <select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}
                                    className="w-full border border-hui-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-hui-primary/20"
                                >
                                    <option value="ACTIVE">Active</option>
                                    <option value="INACTIVE">Inactive</option>
                                </select>
                            </div>
                        </div>
                    </div>

                    <div className="flex justify-between items-center">
                        <button onClick={handleDelete} className="text-red-500 hover:text-red-700 text-sm font-semibold transition px-2">
                            Delete Subcontractor
                        </button>
                        <div className="flex items-center gap-3">
                            <button onClick={handleInviteToPortal} disabled={inviting} className="hui-btn hui-btn-secondary px-5 py-2.5 text-sm flex items-center gap-2 disabled:opacity-50">
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
                                {inviting ? "Sending..." : "Invite to Portal"}
                            </button>
                            <button onClick={handleSave} disabled={saving} className="hui-btn hui-btn-green px-6 py-2.5 text-sm disabled:opacity-50">
                                {saving ? "Saving..." : "Save Changes"}
                            </button>
                        </div>
                    </div>

                    <ProjectAccessManager subcontractorId={id} />
                </div>

                {/* Right Column: COI & Tasks */}
                <div className="space-y-6">
                    {/* Compliance (COI) component */}
                    <div className="bg-white rounded-xl shadow-sm border border-hui-border overflow-hidden">
                        <div className="p-4 border-b border-hui-border bg-slate-50/50 flex justify-between items-center">
                            <h2 className="text-sm font-bold text-hui-textMain uppercase tracking-wider">Compliance</h2>
                            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider ${sub.coiUploaded ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`}>
                                {sub.coiUploaded ? "Compliant" : "Missing COI"}
                            </span>
                        </div>
                        <div className="p-5">
                            <p className="text-xs text-slate-500 mb-4">Certificate of Insurance (COI) is required for subcontractors to perform work on job sites.</p>
                            
                            {/* TODO: Supabase Storage uploader here in future steps */}
                            {sub.coiUploaded ? (
                                <div className="p-3 border border-emerald-200 bg-emerald-50 rounded-lg flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        <svg className="w-5 h-5 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                                        <div>
                                            <p className="text-sm font-semibold text-emerald-900">COI Uploaded</p>
                                            <p className="text-xs text-emerald-700">{sub.coiExpiresAt ? `Expires: ${new Date(sub.coiExpiresAt).toLocaleDateString()}` : "No exp set"}</p>
                                        </div>
                                    </div>
                                    <button className="text-xs font-medium text-emerald-700 hover:text-emerald-900 underline">View</button>
                                </div>
                            ) : (
                                <div>
                                    <input 
                                        type="file" 
                                        ref={fileInputRef} 
                                        className="hidden" 
                                        accept=".pdf,.png,.jpg,.jpeg" 
                                        onChange={handleUploadCOI} 
                                    />
                                    <button 
                                        onClick={() => fileInputRef.current?.click()}
                                        disabled={uploadingCoi}
                                        className="w-full flex items-center justify-center gap-2 py-3 border border-dashed border-slate-300 rounded-lg text-sm font-medium text-slate-500 hover:text-hui-primary hover:border-hui-primary hover:bg-indigo-50 transition disabled:opacity-50"
                                    >
                                        {uploadingCoi ? (
                                            <>
                                                <svg className="animate-spin w-4 h-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                                                Uploading...
                                            </>
                                        ) : (
                                            <>
                                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
                                                Upload COI Document
                                            </>
                                        )}
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Assigned Tasks */}
                    <div className="bg-white rounded-xl shadow-sm border border-hui-border overflow-hidden">
                        <div className="p-4 border-b border-hui-border bg-slate-50/50">
                            <h2 className="text-sm font-bold text-hui-textMain uppercase tracking-wider">Assigned Schedule Tasks</h2>
                        </div>
                        <div className="p-2">
                            {sub.taskAssignments.length === 0 ? (
                                <div className="p-4 text-center text-sm text-slate-400">No tasks assigned yet.</div>
                            ) : (
                                <ul className="divide-y divide-slate-100">
                                    {sub.taskAssignments.map(ta => (
                                        <li key={ta.taskId} className="p-3 hover:bg-slate-50 transition rounded-lg">
                                            <p className="text-sm font-semibold text-hui-textMain">{ta.task.name}</p>
                                            <p className="text-xs text-slate-500">{ta.task.project.name}</p>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
