"use client";
export const dynamic = "force-dynamic";

import { useState, useEffect } from "react";
import { formatCurrency } from "@/lib/utils";
import Link from "next/link";
import { toast } from "sonner";
import RatesImport from "./RatesImport";
import { zeroRateBlocks } from "@/lib/pay-rate-guard";

type User = {
    id: string;
    name: string | null;
    email: string;
    role: string;
    status: string;
    hourlyRate: number;
    burdenRate: number;
    /** ISO string over the wire — last time this rate was confirmed (import or manual save). */
    lastRateSyncAt: string | null;
    showOnDispatch: boolean;
    hasPin: boolean;
    projectAccess?: { projectId: string }[];
};

/** A rate nobody has confirmed in three months is a rate nobody should trust. */
const RATE_STALE_DAYS = 90;

function rateSyncLabel(lastRateSyncAt: string | null): { text: string; stale: boolean } {
    if (!lastRateSyncAt) return { text: "Never", stale: true };
    const at = new Date(lastRateSyncAt);
    if (Number.isNaN(at.getTime())) return { text: "Never", stale: true };
    const days = Math.floor((Date.now() - at.getTime()) / 86_400_000);
    const text = days <= 0 ? "Today" : days === 1 ? "Yesterday" : `${days} days ago`;
    return { text, stale: days > RATE_STALE_DAYS };
}

export default function TeamPage() {
    const [users, setUsers] = useState<User[]>([]);
    const [loading, setLoading] = useState(true);
    const [isAddingUser, setIsAddingUser] = useState(false);
    const [addForm, setAddForm] = useState<Partial<User>>({ role: 'FIELD_CREW' });
    const [searchQuery, setSearchQuery] = useState("");
    const [statusFilter, setStatusFilter] = useState("All");

    useEffect(() => {
        fetchUsers();
    }, []);

    async function fetchUsers() {
        const res = await fetch('/api/users');
        if (res.ok) {
            const data = await res.json();
            setUsers(data);
        } else {
            console.error("Failed to fetch users");
        }
        setLoading(false);
    }

    const handleAddSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        const res = await fetch('/api/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(addForm)
        });

        if (res.ok) {
            const data = await res.json();
            setIsAddingUser(false);
            setAddForm({ role: 'FIELD_CREW', email: '' });

            if (data.warning) {
                toast.warning(data.warning);
            } else {
                toast.success("Team member invited successfully.");
            }

            fetchUsers();
        } else {
            const data = await res.json();
            console.error("Add user failed:", data);
            toast.error(data.error || "Failed to add user");
        }
    };

    const getStatus = (user: User) => {
        if (user.status === "DISABLED") return "Disabled";
        if (!user.name) return "Pending";
        return "Activated";
    };

    const filteredUsers = users.filter(user => {
        const matchesSearch = (user.name?.toLowerCase() || '').includes(searchQuery.toLowerCase()) || 
                              user.email.toLowerCase().includes(searchQuery.toLowerCase());
        const status = getStatus(user);
        const matchesStatus = statusFilter === "All" || status === statusFilter;
        return matchesSearch && matchesStatus;
    });

    // Payroll rates panel: ACTIVATED members only. A pending invite has no
    // hours yet and a disabled account is off payroll — neither belongs in a
    // list whose job is "what will Gusto pay".
    const activeUsers = users.filter(user => getStatus(user) === "Activated");

    const getInitials = (name: string | null, email: string) => {
        if (name) {
            const parts = name.split(' ');
            if (parts.length > 1) return (parts[0][0] + parts[1][0]).toUpperCase();
            return name.substring(0, 2).toUpperCase();
        }
        return email.substring(0, 2).toUpperCase();
    };

    return (
        <div className="font-sans text-slate-900 h-full flex flex-col">
            <header className="bg-white border-b border-hui-border px-8 py-4 flex items-center justify-between sticky top-0 z-10">
                <h1 className="text-xl font-bold text-hui-textMain">Team Members</h1>
                <button
                    onClick={() => setIsAddingUser(true)}
                    className="hui-btn hui-btn-primary"
                >
                    + Add Team Member
                </button>
            </header>

            <div className="p-8 flex-1 overflow-y-auto w-full max-w-7xl mx-auto bg-hui-background">
                <div className="mb-6 bg-green-50 text-green-800 px-4 py-3 rounded-md border border-green-200 flex items-center shadow-sm">
                    <span className="font-medium text-sm">11 Free Seats — {users.length} Used, {11 - users.length} Available</span>
                </div>

                <div className="mb-6 flex gap-4 items-center">
                    <input 
                        type="text" 
                        placeholder="Search team members..." 
                        value={searchQuery}
                        onChange={e => setSearchQuery(e.target.value)}
                        className="hui-input max-w-sm w-full"
                    />
                    <select 
                        value={statusFilter}
                        onChange={e => setStatusFilter(e.target.value)}
                        className="hui-input max-w-xs w-full cursor-pointer"
                    >
                        <option value="All">All Statuses</option>
                        <option value="Activated">Activated</option>
                        <option value="Pending">Pending</option>
                        <option value="Disabled">Disabled</option>
                    </select>
                </div>

                {loading ? (
                    <div className="text-center py-20 text-hui-textMuted">Loading team members...</div>
                ) : (
                    <div className="hui-card overflow-hidden">
                        <table className="w-full text-left border-collapse">
                            <thead>
                                <tr className="bg-slate-50 border-b border-hui-border text-sm font-semibold text-hui-textMuted whitespace-nowrap">
                                    <th className="px-6 py-4 font-normal">Name</th>
                                    <th className="px-6 py-4 font-normal">Email</th>
                                    <th className="px-6 py-4 font-normal">Role</th>
                                    <th className="px-6 py-4 font-normal">Status</th>
                                    <th className="px-6 py-4 font-normal hidden sm:table-cell">Projects</th>
                                    <th className="px-6 py-4 font-normal hidden sm:table-cell">Hourly Rate</th>
                                    <th className="px-6 py-4 font-normal hidden sm:table-cell text-center">Dispatch</th>
                                    <th className="px-6 py-4 font-normal text-right">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-hui-border text-sm">
                                {filteredUsers.map(user => {
                                    const status = getStatus(user);
                                    let badgeBg = "bg-slate-100";
                                    let badgeText = "text-slate-800";
                                    let badgeDot = "bg-slate-500";
                                    
                                    if (status === "Activated") {
                                        badgeBg = "bg-green-50";
                                        badgeText = "text-green-800";
                                        badgeDot = "bg-green-500";
                                    } else if (status === "Pending") {
                                        badgeBg = "bg-amber-50";
                                        badgeText = "text-amber-800";
                                        badgeDot = "bg-amber-500";
                                    } else if (status === "Disabled") {
                                        badgeBg = "bg-slate-100";
                                        badgeText = "text-slate-800";
                                        badgeDot = "bg-slate-400";
                                    }

                                    return (
                                        <tr key={user.id} className="hover:bg-slate-50 transition-colors group">
                                            <td className="px-6 py-4">
                                                <div className="flex items-center gap-3">
                                                    <div className="w-8 h-8 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center font-bold text-xs shrink-0">
                                                        {getInitials(user.name, user.email)}
                                                    </div>
                                                    <div className="font-medium text-hui-textMain">
                                                        {user.name || 'Invited User'}
                                                    </div>
                                                </div>
                                            </td>
                                            <td className="px-6 py-4 text-hui-textMuted">
                                                {user.email}
                                            </td>
                                            <td className="px-6 py-4 text-hui-textMuted">
                                                {(user.role === 'FIELD_CREW' || user.role === 'EMPLOYEE') ? 'Field Crew' :
                                                    user.role === 'MANAGER' ? 'Manager' :
                                                        user.role === 'FINANCE' ? 'Finance' :
                                                            'Admin'}
                                            </td>
                                            <td className="px-6 py-4">
                                                <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium ${badgeBg} ${badgeText}`}>
                                                    <span className={`w-1.5 h-1.5 rounded-full ${badgeDot}`}></span>
                                                    {status}
                                                </span>
                                            </td>
                                            <td className="px-6 py-4 text-hui-textMuted hidden sm:table-cell">
                                                {user.role === "ADMIN" || user.role === "MANAGER"
                                                    ? "All"
                                                    : new Set([
                                                        ...(user.projectAccess?.map(pa => pa.projectId) || []),
                                                        ...((user as any).assignedProjects?.map((p: any) => p.id) || []),
                                                    ]).size}
                                            </td>
                                            <td className="px-6 py-4 text-hui-textMuted hidden sm:table-cell">
                                                {formatCurrency(user.hourlyRate ?? 0)}
                                            </td>
                                            <td className="px-6 py-4 text-hui-textMuted hidden sm:table-cell text-center" title={user.showOnDispatch ? "Shows on the dispatch board" : "Not on the dispatch board"}>
                                                {user.showOnDispatch ? "✓" : "—"}
                                            </td>
                                            <td className="px-6 py-4 text-right">
                                                <Link
                                                    href={`/company/team-members/${user.id}`}
                                                    className="text-blue-600 hover:text-blue-800 font-medium opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto transition"
                                                >
                                                    Edit
                                                </Link>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                        {filteredUsers.length === 0 && (
                            <div className="p-6 text-center text-hui-textMuted">No team members found.</div>
                        )}
                    </div>
                )}

                {/* Payroll rates (Phase 5 G1). Deliberately a separate panel from the
                    roster table above: the roster is about access, this is about what
                    payroll will pay. "Last synced" is the staleness marker — a rate
                    nobody has confirmed is the one that quietly goes to Gusto wrong. */}
                <div className="mt-8 hui-card overflow-hidden">
                    <div className="px-6 py-4 border-b border-hui-border flex items-center justify-between">
                        <div>
                            <h2 className="font-semibold text-hui-textMain">Payroll rates</h2>
                            <p className="text-xs text-hui-textMuted mt-0.5">
                                Hourly rate drives labor cost and the Gusto hours export. Burden rate is ProBuild-only
                                job costing and is edited on each member&apos;s page.
                            </p>
                        </div>
                        <RatesImport onImported={fetchUsers} />
                    </div>
                    <table className="w-full text-left border-collapse text-sm">
                        <thead>
                            <tr className="bg-slate-50 border-b border-hui-border text-xs font-semibold text-hui-textMuted whitespace-nowrap">
                                <th className="px-6 py-3 font-normal">Name</th>
                                <th className="px-6 py-3 font-normal">Role</th>
                                <th className="px-6 py-3 font-normal text-right">Hourly rate</th>
                                <th className="px-6 py-3 font-normal text-right">Burden rate</th>
                                <th className="px-6 py-3 font-normal">Last synced</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-hui-border">
                            {activeUsers.map(user => {
                                const sync = rateSyncLabel(user.lastRateSyncAt);
                                const noRate = zeroRateBlocks({ role: user.role, hourlyRate: user.hourlyRate ?? 0 });
                                return (
                                    <tr key={user.id} className="hover:bg-slate-50 transition-colors">
                                        <td className="px-6 py-3">
                                            <Link href={`/company/team-members/${user.id}`} className="font-medium text-hui-textMain hover:text-blue-700">
                                                {user.name || user.email}
                                            </Link>
                                            {noRate && (
                                                <span
                                                    className="ml-2 text-xs text-red-700 bg-red-50 px-2 py-0.5 rounded border border-red-200"
                                                    title="No hourly rate — this member cannot clock out until one is set"
                                                >
                                                    No pay rate
                                                </span>
                                            )}
                                        </td>
                                        <td className="px-6 py-3 text-hui-textMuted">
                                            {(user.role === 'FIELD_CREW' || user.role === 'EMPLOYEE') ? 'Field Crew' :
                                                user.role === 'MANAGER' ? 'Manager' :
                                                    user.role === 'FINANCE' ? 'Finance' : 'Admin'}
                                        </td>
                                        <td className="px-6 py-3 text-right tabular-nums text-hui-textMain">
                                            {formatCurrency(user.hourlyRate ?? 0)}/h
                                        </td>
                                        <td className="px-6 py-3 text-right tabular-nums text-hui-textMuted">
                                            {formatCurrency(user.burdenRate ?? 0)}/h
                                        </td>
                                        <td className={`px-6 py-3 ${sync.stale ? "text-red-700" : "text-hui-textMuted"}`}>
                                            {sync.text}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                    {activeUsers.length === 0 && (
                        <div className="p-6 text-center text-hui-textMuted">No activated team members yet.</div>
                    )}
                </div>
            </div>

            {/* Add User Modal */}
            {isAddingUser && (
                <div className="fixed inset-0 bg-slate-900/50 flex flex-col items-center justify-center z-50 p-4">
                    <div className="bg-white rounded-xl shadow-xl max-w-md w-full overflow-hidden border border-hui-border">
                        <div className="px-6 py-4 border-b border-hui-border flex justify-between items-center">
                            <h2 className="text-lg font-bold text-hui-textMain">Invite New Team Member</h2>
                            <button onClick={() => setIsAddingUser(false)} className="text-hui-textMuted hover:text-hui-textMain transition">
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                            </button>
                        </div>
                        <form onSubmit={handleAddSubmit} className="p-6 space-y-4 text-sm">
                            <p className="text-hui-textMuted mb-2 leading-relaxed">
                                Enter the team member&apos;s role and email address. They will be able to log in using their Google account to access the platform.
                            </p>
                            <div>
                                <label className="block font-medium text-hui-textMain mb-1">Email Address <span className="text-red-500">*</span></label>
                                <input required type="email" placeholder="email@company.com" className="hui-input w-full" value={addForm.email || ''} onChange={e => setAddForm({ ...addForm, email: e.target.value })} />
                            </div>
                            <div>
                                <label className="block font-medium text-hui-textMain mb-1">Role</label>
                                <select className="hui-input w-full" value={addForm.role} onChange={e => setAddForm({ ...addForm, role: e.target.value })}>
                                    <option value="FIELD_CREW">Field Crew</option>
                                    <option value="MANAGER">Manager</option>
                                    <option value="FINANCE">Finance</option>
                                    <option value="ADMIN">Admin</option>
                                </select>
                            </div>

                            <div className="pt-4 flex justify-end gap-3 border-t border-hui-border mt-6">
                                <button type="button" onClick={() => setIsAddingUser(false)} className="hui-btn hui-btn-secondary">Cancel</button>
                                <button type="submit" className="hui-btn hui-btn-primary">Send Invite</button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}

