"use client";
import { useState, useEffect } from "react";
import Link from "next/link";
import { toast } from "sonner";

interface TeamMember {
    id: string;
    name: string | null;
    email: string;
    role: string;
    status: string;
    invitedAt: string | null;
}

const ROLE_LABELS: Record<string, string> = { ADMIN: "Admin", MANAGER: "Manager", FIELD_CREW: "Field Crew", FINANCE: "Finance", EMPLOYEE: "Employee" };
const STATUS_COLORS: Record<string, string> = {
    ACTIVATED: "text-emerald-600 bg-emerald-50",
    PENDING: "text-amber-600 bg-amber-50",
    DISABLED: "text-slate-400 bg-slate-100",
};

export default function TeamPage() {
    const [members, setMembers] = useState<TeamMember[]>([]);
    const [search, setSearch] = useState("");
    const [statusFilter, setStatusFilter] = useState("ALL");
    const [showInvite, setShowInvite] = useState(false);
    const [inviteForm, setInviteForm] = useState({ name: "", email: "", role: "FIELD_CREW" });
    const [inviting, setInviting] = useState(false);

    useEffect(() => { fetchMembers(); }, []);

    async function fetchMembers() {
        const res = await fetch("/api/users");
        if (res.ok) setMembers(await res.json());
    }

    async function handleInvite(e: React.FormEvent) {
        e.preventDefault();
        setInviting(true);
        try {
            const res = await fetch("/api/users", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(inviteForm),
            });
            const data = await res.json();
            if (!res.ok) { toast.error(data.error || "Failed to invite"); return; }
            toast.success(`Invited ${data.email}`);
            setShowInvite(false);
            setInviteForm({ name: "", email: "", role: "FIELD_CREW" });
            fetchMembers();
        } catch { toast.error("Failed to invite"); } finally { setInviting(false); }
    }

    const filtered = members.filter(m => {
        if (statusFilter !== "ALL" && m.status !== statusFilter) return false;
        if (search && !m.name?.toLowerCase().includes(search.toLowerCase()) && !m.email.toLowerCase().includes(search.toLowerCase())) return false;
        return true;
    });

    const usedSeats = members.filter(m => m.status !== "DISABLED").length;

    return (
        <div className="flex-1 p-6 md:p-8 max-w-6xl">
            <div className="flex items-center justify-between mb-6">
                <div>
                    <h1 className="text-2xl font-bold text-hui-textMain">Team Members</h1>
                    <p className="text-sm text-slate-500 mt-1">{usedSeats} Active · {members.length} Total</p>
                </div>
                <button
                    onClick={() => setShowInvite(true)}
                    className="bg-hui-primary text-white px-5 py-2.5 rounded-lg text-sm font-semibold hover:bg-indigo-700 transition shadow-sm"
                >
                    Invite Team Member
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
                    <option value="ACTIVATED">Activated</option>
                    <option value="PENDING">Pending</option>
                    <option value="DISABLED">Disabled</option>
                </select>
            </div>

            {/* Members Table */}
            <div className="bg-white rounded-xl border border-hui-border shadow-sm overflow-hidden">
                <table className="w-full">
                    <thead>
                        <tr className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wider border-b border-hui-border bg-slate-50/50">
                            <th className="px-5 py-3">Name</th>
                            <th className="px-5 py-3">Email</th>
                            <th className="px-5 py-3">Role</th>
                            <th className="px-5 py-3">Status</th>
                            <th className="px-5 py-3">Invite Date</th>
                        </tr>
                    </thead>
                    <tbody>
                        {filtered.map(m => (
                            <tr key={m.id} className="border-b border-hui-border last:border-0 hover:bg-slate-50/50 transition">
                                <td className="px-5 py-3.5">
                                    <Link href={`/settings/team/${m.id}`} className="flex items-center gap-3 group">
                                        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-100 to-purple-100 flex items-center justify-center text-xs font-bold text-indigo-600 shrink-0">
                                            {(m.name || m.email).substring(0, 2).toUpperCase()}
                                        </div>
                                        <span className="text-sm font-semibold text-hui-textMain group-hover:text-hui-primary transition">{m.name || "—"}</span>
                                    </Link>
                                </td>
                                <td className="px-5 py-3.5 text-sm text-slate-500">{m.email}</td>
                                <td className="px-5 py-3.5 text-sm font-medium text-hui-textMain">{ROLE_LABELS[m.role] || m.role}</td>
                                <td className="px-5 py-3.5">
                                    <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${STATUS_COLORS[m.status] || "text-slate-500 bg-slate-100"}`}>
                                        {m.status === "ACTIVATED" ? "Activated" : m.status === "PENDING" ? "Pending" : "Disabled"}
                                    </span>
                                </td>
                                <td className="px-5 py-3.5 text-sm text-slate-400">
                                    {m.invitedAt ? new Date(m.invitedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—"}
                                </td>
                            </tr>
                        ))}
                        {filtered.length === 0 && (
                            <tr><td colSpan={5} className="text-center text-sm text-slate-400 py-12">No team members found</td></tr>
                        )}
                    </tbody>
                </table>
            </div>

            {/* Invite Modal */}
            {showInvite && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowInvite(false)}>
                    <form onSubmit={handleInvite} className="bg-white rounded-2xl shadow-2xl w-[440px] p-6" onClick={e => e.stopPropagation()}>
                        <h2 className="text-lg font-bold text-hui-textMain mb-5">Invite Team Member</h2>
                        <div className="space-y-4">
                            <div>
                                <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1 block">Full Name</label>
                                <input type="text" value={inviteForm.name} onChange={e => setInviteForm(p => ({ ...p, name: e.target.value }))}
                                    className="w-full border border-hui-border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-hui-primary/20"
                                    placeholder="John Smith"
                                />
                            </div>
                            <div>
                                <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1 block">Email *</label>
                                <input type="email" required value={inviteForm.email} onChange={e => setInviteForm(p => ({ ...p, email: e.target.value }))}
                                    className="w-full border border-hui-border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-hui-primary/20"
                                    placeholder="john@company.com"
                                />
                            </div>
                            <div>
                                <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1 block">Role</label>
                                <select value={inviteForm.role} onChange={e => setInviteForm(p => ({ ...p, role: e.target.value }))}
                                    className="w-full border border-hui-border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-hui-primary/20 bg-white"
                                >
                                    <option value="FIELD_CREW">Field Crew</option>
                                    <option value="FINANCE">Finance</option>
                                    <option value="MANAGER">Manager</option>
                                    <option value="ADMIN">Admin</option>
                                </select>
                            </div>
                        </div>
                        <div className="flex justify-end gap-3 mt-6">
                            <button type="button" onClick={() => setShowInvite(false)} className="px-4 py-2 text-sm text-slate-500 hover:text-slate-700 transition">Cancel</button>
                            <button type="submit" disabled={inviting}
                                className="bg-hui-primary text-white px-5 py-2 rounded-lg text-sm font-semibold hover:bg-indigo-700 transition disabled:opacity-50"
                            >
                                {inviting ? "Sending…" : "Send Invite"}
                            </button>
                        </div>
                    </form>
                </div>
            )}
        </div>
    );
}
