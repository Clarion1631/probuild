"use client";
import { useState, useEffect } from "react";
import Link from "next/link";
import { toast } from "sonner";

interface Subcontractor {
    id: string;
    companyName: string;
    contactName: string | null;
    email: string;
    phone: string | null;
    trade: string | null;
    status: string;
    coiUploaded: boolean;
}

export default function SubcontractorsPage() {
    const [subs, setSubs] = useState<Subcontractor[]>([]);
    const [search, setSearch] = useState("");
    const [statusFilter, setStatusFilter] = useState("ALL");
    const [showAdd, setShowAdd] = useState(false);
    const [addForm, setAddForm] = useState({ companyName: "", contactName: "", email: "", phone: "", trade: "" });
    const [adding, setAdding] = useState(false);

    useEffect(() => { fetchSubs(); }, []);

    async function fetchSubs() {
        const res = await fetch("/api/subcontractors");
        if (res.ok) setSubs(await res.json());
    }

    async function handleAdd(e: React.FormEvent) {
        e.preventDefault();
        setAdding(true);
        try {
            const res = await fetch("/api/subcontractors", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(addForm),
            });
            const data = await res.json();
            if (!res.ok) { toast.error(data.error || "Failed to add Subcontractor"); return; }
            toast.success(`Added ${data.companyName}`);
            setShowAdd(false);
            setAddForm({ companyName: "", contactName: "", email: "", phone: "", trade: "" });
            fetchSubs();
        } catch { toast.error("Failed to add"); } finally { setAdding(false); }
    }

    const filtered = subs.filter(s => {
        if (statusFilter !== "ALL" && s.status !== statusFilter) return false;
        if (search && !s.companyName.toLowerCase().includes(search.toLowerCase()) && !s.email.toLowerCase().includes(search.toLowerCase())) return false;
        return true;
    });

    return (
        <div className="flex-1 p-6 md:p-8 max-w-6xl">
            <div className="flex items-center justify-between mb-6">
                <div>
                    <h1 className="text-2xl font-bold text-hui-textMain">Subcontractors</h1>
                    <p className="text-sm text-slate-500 mt-1">{subs.length} Total</p>
                </div>
                <button
                    onClick={() => setShowAdd(true)}
                    className="bg-hui-primary text-white px-5 py-2.5 rounded-lg text-sm font-semibold hover:bg-indigo-700 transition shadow-sm"
                >
                    Add Subcontractor
                </button>
            </div>

            {/* Filters */}
            <div className="flex items-center gap-3 mb-5">
                <div className="relative flex-1 max-w-xs">
                    <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
                    <input
                        type="text" placeholder="Search" value={search} onChange={e => setSearch(e.target.value)}
                        className="w-full pl-9 pr-4 py-2 border border-hui-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-hui-primary/20 bg-white"
                    />
                </div>
                <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
                    className="border border-hui-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-hui-primary/20"
                >
                    <option value="ALL">All Status</option>
                    <option value="ACTIVE">Active</option>
                    <option value="INACTIVE">Inactive</option>
                </select>
            </div>

            {/* Table */}
            <div className="bg-white rounded-xl border border-hui-border shadow-sm overflow-hidden">
                <table className="w-full">
                    <thead>
                        <tr className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wider border-b border-hui-border bg-slate-50/50">
                            <th className="px-5 py-3">Company</th>
                            <th className="px-5 py-3">Contact</th>
                            <th className="px-5 py-3">Trade</th>
                            <th className="px-5 py-3">COI Status</th>
                            <th className="px-5 py-3">Status</th>
                        </tr>
                    </thead>
                    <tbody>
                        {filtered.map(s => (
                            <tr key={s.id} className="border-b border-hui-border last:border-0 hover:bg-slate-50/50 transition">
                                <td className="px-5 py-3.5">
                                    <Link href={`/settings/subcontractors/${s.id}`} className="font-semibold text-hui-textMain hover:text-hui-primary transition">
                                        {s.companyName}
                                    </Link>
                                    <p className="text-xs text-slate-500 mt-0.5">{s.email}</p>
                                </td>
                                <td className="px-5 py-3.5 text-sm text-slate-600">{s.contactName || "—"}<br/><span className="text-xs text-slate-400">{s.phone}</span></td>
                                <td className="px-5 py-3.5 text-sm text-slate-600">{s.trade || "—"}</td>
                                <td className="px-5 py-3.5">
                                    <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${s.coiUploaded ? "text-emerald-600 bg-emerald-50" : "text-slate-500 bg-slate-100"}`}>
                                        {s.coiUploaded ? "Uploaded" : "Missing"}
                                    </span>
                                </td>
                                <td className="px-5 py-3.5">
                                    <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${s.status === "ACTIVE" ? "text-emerald-600 bg-emerald-50" : "text-amber-600 bg-amber-50"}`}>
                                        {s.status}
                                    </span>
                                </td>
                            </tr>
                        ))}
                        {filtered.length === 0 && (
                            <tr><td colSpan={5} className="text-center text-sm text-slate-400 py-12">No subcontractors found</td></tr>
                        )}
                    </tbody>
                </table>
            </div>

            {/* Add Modal */}
            {showAdd && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowAdd(false)}>
                    <form onSubmit={handleAdd} className="bg-white rounded-2xl shadow-2xl w-[440px] p-6" onClick={e => e.stopPropagation()}>
                        <h2 className="text-lg font-bold text-hui-textMain mb-5">Add Subcontractor</h2>
                        <div className="space-y-4">
                            <div>
                                <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1 block">Company Name *</label>
                                <input type="text" required value={addForm.companyName} onChange={e => setAddForm(p => ({ ...p, companyName: e.target.value }))}
                                    className="w-full border border-hui-border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-hui-primary/20"
                                />
                            </div>
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1 block">Contact Name</label>
                                    <input type="text" value={addForm.contactName} onChange={e => setAddForm(p => ({ ...p, contactName: e.target.value }))}
                                        className="w-full border border-hui-border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-hui-primary/20"
                                    />
                                </div>
                                <div>
                                    <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1 block">Trade</label>
                                    <input type="text" value={addForm.trade} onChange={e => setAddForm(p => ({ ...p, trade: e.target.value }))}
                                        className="w-full border border-hui-border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-hui-primary/20" placeholder="e.g. Plumbing"
                                    />
                                </div>
                            </div>
                            <div>
                                <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1 block">Email *</label>
                                <input type="email" required value={addForm.email} onChange={e => setAddForm(p => ({ ...p, email: e.target.value }))}
                                    className="w-full border border-hui-border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-hui-primary/20"
                                />
                            </div>
                            <div>
                                <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1 block">Phone</label>
                                <input type="tel" value={addForm.phone} onChange={e => setAddForm(p => ({ ...p, phone: e.target.value }))}
                                    className="w-full border border-hui-border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-hui-primary/20"
                                />
                            </div>
                        </div>
                        <div className="flex justify-end gap-3 mt-6">
                            <button type="button" onClick={() => setShowAdd(false)} className="px-4 py-2 text-sm text-slate-500 hover:text-slate-700 transition">Cancel</button>
                            <button type="submit" disabled={adding}
                                className="bg-hui-primary text-white px-5 py-2 rounded-lg text-sm font-semibold hover:bg-indigo-700 transition disabled:opacity-50"
                            >
                                {adding ? "Adding…" : "Add"}
                            </button>
                        </div>
                    </form>
                </div>
            )}
        </div>
    );
}
