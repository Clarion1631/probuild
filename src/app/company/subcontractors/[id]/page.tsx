"use client";
import { useState, useEffect, use } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

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
    taskAssignments: TaskAssignment[];
}

export default function SubcontractorDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = use(params);
    const router = useRouter();
    const [sub, setSub] = useState<Subcontractor | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    
    // Form state
    const [form, setForm] = useState({
        companyName: "",
        contactName: "",
        email: "",
        phone: "",
        trade: "",
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
            router.push("/settings/subcontractors");
            return;
        }
        const data = await res.json();
        setSub(data);
        setForm({
            companyName: data.companyName || "",
            contactName: data.contactName || "",
            email: data.email || "",
            phone: data.phone || "",
            trade: data.trade || "",
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
            router.push("/settings/subcontractors");
        } catch {
            toast.error("Failed to delete subcontractor");
        }
    }

    if (loading) return <div className="p-8 text-slate-500">Loading...</div>;
    if (!sub) return null;

    return (
        <div className="flex-1 p-6 md:p-8 max-w-5xl">
            {/* Header */}
            <div className="flex items-center gap-4 mb-8">
                <Link href="/settings/subcontractors" className="p-2 hover:bg-slate-100 rounded-full transition text-slate-400 hover:text-hui-primary">
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
                        <h2 className="text-sm font-bold text-hui-textMain uppercase tracking-wider mb-5">Company Details</h2>
                        
                        <div className="grid grid-cols-2 gap-5 mb-5">
                            <div>
                                <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1 block">Company Name</label>
                                <input type="text" value={form.companyName} onChange={e => setForm(f => ({ ...f, companyName: e.target.value }))}
                                    className="w-full border border-hui-border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-hui-primary/20"
                                />
                            </div>
                            <div>
                                <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1 block">Trade / Specialty</label>
                                <input type="text" value={form.trade} onChange={e => setForm(f => ({ ...f, trade: e.target.value }))}
                                    className="w-full border border-hui-border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-hui-primary/20"
                                />
                            </div>
                        </div>

                        <div className="grid grid-cols-2 gap-5 mb-5">
                            <div>
                                <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1 block">Contact Name</label>
                                <input type="text" value={form.contactName} onChange={e => setForm(f => ({ ...f, contactName: e.target.value }))}
                                    className="w-full border border-hui-border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-hui-primary/20"
                                />
                            </div>
                            <div>
                                <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1 block">License Number</label>
                                <input type="text" value={form.licenseNumber} onChange={e => setForm(f => ({ ...f, licenseNumber: e.target.value }))}
                                    className="w-full border border-hui-border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-hui-primary/20"
                                />
                            </div>
                        </div>

                        <div className="grid grid-cols-2 gap-5 mb-6">
                            <div>
                                <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1 block">Email</label>
                                <input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                                    className="w-full border border-hui-border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-hui-primary/20"
                                />
                            </div>
                            <div>
                                <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1 block">Phone</label>
                                <input type="tel" value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                                    className="w-full border border-hui-border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-hui-primary/20"
                                />
                            </div>
                        </div>

                        <div>
                            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1 block">Status</label>
                            <select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}
                                className="w-full border border-hui-border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-hui-primary/20"
                            >
                                <option value="ACTIVE">Active</option>
                                <option value="INACTIVE">Inactive</option>
                            </select>
                        </div>
                    </div>

                    <div className="flex justify-between items-center">
                        <button onClick={handleDelete} className="text-red-500 hover:text-red-700 text-sm font-semibold transition px-2">
                            Delete Subcontractor
                        </button>
                        <button onClick={handleSave} disabled={saving} className="bg-hui-primary text-white px-6 py-2.5 rounded-lg text-sm font-semibold hover:bg-indigo-700 transition shadow-sm disabled:opacity-50">
                            {saving ? "Saving..." : "Save Changes"}
                        </button>
                    </div>
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
                                <button className="w-full flex items-center justify-center gap-2 py-3 border border-dashed border-slate-300 rounded-lg text-sm font-medium text-slate-500 hover:text-hui-primary hover:border-hui-primary hover:bg-indigo-50 transition">
                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
                                    Upload COI Document
                                </button>
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
