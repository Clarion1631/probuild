"use client";
import { useState, useEffect, use } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { PERMISSION_GROUPS, ROLE_LABELS } from "@/lib/permissions";

interface UserDetail {
    id: string;
    name: string | null;
    email: string;
    role: string;
    status: string;
    hourlyRate: number;
    burdenRate: number;
    invitedAt: string | null;
    permissions: Record<string, boolean> | null;
    projectAccess: { projectId: string; project: { id: string; name: string; client: { name: string } | null; createdAt: string } }[];
}

interface ProjectSummary {
    id: string;
    name: string;
    client: { name: string } | null;
    createdAt: string;
}

export default function TeamMemberEditPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = use(params);
    const router = useRouter();
    const [user, setUser] = useState<UserDetail | null>(null);
    const [allProjects, setAllProjects] = useState<ProjectSummary[]>([]);
    const [activeTab, setActiveTab] = useState<"permissions" | "projects" | "notifications">("permissions");
    const [saving, setSaving] = useState(false);
    const [permissions, setPermissions] = useState<Record<string, boolean>>({});
    const [accessProjectIds, setAccessProjectIds] = useState<Set<string>>(new Set());
    const [autoGrant, setAutoGrant] = useState(true);
    const [role, setRole] = useState("FIELD_CREW");
    const [name, setName] = useState("");
    const [projectSearch, setProjectSearch] = useState("");

    useEffect(() => {
        fetch(`/api/users/${id}`)
            .then(r => r.json())
            .then(data => {
                if (data.user) {
                    setUser(data.user);
                    setRole(data.user.role);
                    setName(data.user.name || "");
                    if (data.user.permissions) {
                        setPermissions(data.user.permissions);
                        setAutoGrant(data.user.permissions.autoGrantNewProjects ?? true);
                    }
                    setAccessProjectIds(new Set(data.user.projectAccess.map((pa: any) => pa.projectId)));
                }
                if (data.allProjects) setAllProjects(data.allProjects);
            });
    }, [id]);

    async function handleSave() {
        setSaving(true);
        try {
            const permData = { ...permissions, autoGrantNewProjects: autoGrant };
            // Remove non-permission fields
            const { id: _, userId, user: __, ...cleanPerms } = permData as any;

            const res = await fetch(`/api/users/${id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    userInfo: { name, role },
                    permissions: cleanPerms,
                    projectIds: Array.from(accessProjectIds),
                }),
            });
            if (!res.ok) { const d = await res.json(); toast.error(d.error || "Save failed"); return; }
            toast.success("Saved");
        } catch { toast.error("Save failed"); } finally { setSaving(false); }
    }

    async function handleDisable() {
        if (!confirm(`${user?.status === "DISABLED" ? "Enable" : "Disable"} this team member?`)) return;
        const newStatus = user?.status === "DISABLED" ? "ACTIVATED" : "DISABLED";
        const res = await fetch("/api/users", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, status: newStatus }),
        });
        if (res.ok) {
            const data = await res.json();
            setUser(prev => prev ? { ...prev, status: data.status } : null);
            toast.success(newStatus === "DISABLED" ? "Team member disabled" : "Team member enabled");
        }
    }

    async function handleDelete() {
        if (!confirm("Permanently delete this team member? This cannot be undone.")) return;
        const res = await fetch(`/api/users/${id}`, { method: "DELETE" });
        if (res.ok) { toast.success("Deleted"); router.push("/settings/team"); }
        else { const d = await res.json(); toast.error(d.error || "Delete failed"); }
    }

    function togglePermission(key: string) {
        setPermissions(prev => ({ ...prev, [key]: !prev[key] }));
    }

    function toggleProjectAccess(projectId: string) {
        setAccessProjectIds(prev => {
            const next = new Set(prev);
            if (next.has(projectId)) next.delete(projectId); else next.add(projectId);
            return next;
        });
    }

    function toggleAllProjects(checked: boolean) {
        if (checked) setAccessProjectIds(new Set(allProjects.map(p => p.id)));
        else setAccessProjectIds(new Set());
    }

    const isAdmin = ["ADMIN", "MANAGER"].includes(role);
    const filteredProjects = allProjects.filter(p =>
        !projectSearch || p.name.toLowerCase().includes(projectSearch.toLowerCase()) || p.client?.name?.toLowerCase().includes(projectSearch.toLowerCase())
    );

    if (!user) return <div className="flex-1 p-8"><div className="animate-pulse text-slate-400">Loading…</div></div>;

    return (
        <div className="flex-1 p-6 md:p-8 max-w-4xl">
            {/* Header */}
            <Link href="/settings/team" className="text-sm text-hui-primary hover:underline mb-4 inline-flex items-center gap-1">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l-6-6 6-6"/></svg>
                Back to Team Members
            </Link>
            <h2 className="text-sm text-slate-500 mt-3 mb-6">Edit &quot;{user.email}&quot;</h2>

            {/* Name / Role */}
            <div className="bg-white rounded-xl border border-hui-border p-6 mb-6 shadow-sm">
                <h3 className="text-sm font-bold text-hui-textMain uppercase tracking-wider mb-4">Name</h3>
                <div className="grid grid-cols-2 gap-4 mb-6">
                    <div>
                        <label className="text-xs text-slate-500 mb-1 block">Full Name</label>
                        <input type="text" value={name} onChange={e => setName(e.target.value)}
                            className="w-full border border-hui-border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-hui-primary/20"
                        />
                    </div>
                    <div>
                        <label className="text-xs text-slate-500 mb-1 block">Email</label>
                        <p className="text-sm text-hui-textMain bg-slate-50 rounded-lg px-3 py-2.5 border border-hui-border">{user.email}</p>
                    </div>
                </div>

                <h3 className="text-sm font-bold text-hui-textMain uppercase tracking-wider mb-3">Role</h3>
                <select value={role} onChange={e => setRole(e.target.value)}
                    className="border border-hui-border rounded-lg px-3 py-2.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-hui-primary/20 w-48"
                >
                    {Object.entries(ROLE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
            </div>

            {/* Admin/Manager notice */}
            {isAdmin && (
                <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-4 mb-6 text-sm text-indigo-700">
                    <strong>{ROLE_LABELS[role]}</strong> role has full access to all features and projects. Permissions below are for reference only.
                </div>
            )}

            {/* Permissions & Project Access Tabs */}
            <div className="bg-white rounded-xl border border-hui-border shadow-sm overflow-hidden">
                {/* Tabs */}
                <div className="flex border-b border-hui-border">
                    {(["permissions", "projects", "notifications"] as const).map(tab => (
                        <button key={tab} onClick={() => setActiveTab(tab)}
                            className={`px-5 py-3 text-sm font-semibold transition border-b-2 ${activeTab === tab ? "text-hui-primary border-hui-primary" : "text-slate-500 border-transparent hover:text-hui-textMain"}`}
                        >
                            {tab === "permissions" ? "Permissions" : tab === "projects" ? "Project Access" : "Notifications"}
                        </button>
                    ))}
                </div>

                <div className="p-6">
                    {/* PERMISSIONS TAB */}
                    {activeTab === "permissions" && (
                        <div className="space-y-8">
                            {Object.entries(PERMISSION_GROUPS).map(([groupKey, group]) => (
                                <div key={groupKey}>
                                    <h4 className="text-sm font-bold text-hui-textMain uppercase tracking-wider mb-3">{group.label}</h4>
                                    <div className="grid grid-cols-2 gap-x-8 gap-y-2">
                                        {group.keys.map(({ key, label }) => (
                                            <label key={key} className={`flex items-center gap-3 py-1.5 text-sm cursor-pointer ${isAdmin ? "opacity-50" : ""}`}>
                                                <input
                                                    type="checkbox"
                                                    checked={isAdmin || !!permissions[key]}
                                                    onChange={() => togglePermission(key)}
                                                    disabled={isAdmin}
                                                    className="w-4 h-4 rounded border-slate-300 text-hui-primary focus:ring-hui-primary/20"
                                                />
                                                <span className="text-hui-textMain">{label}</span>
                                            </label>
                                        ))}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* PROJECT ACCESS TAB */}
                    {activeTab === "projects" && (
                        <div>
                            <label className="flex items-center gap-3 mb-5 p-3 bg-slate-50 rounded-xl cursor-pointer">
                                <div className={`relative w-10 h-6 rounded-full transition ${autoGrant ? "bg-hui-primary" : "bg-slate-300"}`}>
                                    <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all shadow ${autoGrant ? "left-5" : "left-1"}`} />
                                </div>
                                <span className="text-sm font-medium text-hui-textMain">Grant automatic access to new projects</span>
                            </label>

                            {/* Select All */}
                            <div className="flex items-center justify-between mb-3">
                                <label className="flex items-center gap-2 text-sm cursor-pointer">
                                    <input type="checkbox"
                                        checked={accessProjectIds.size === allProjects.length && allProjects.length > 0}
                                        onChange={e => toggleAllProjects(e.target.checked)}
                                        className="w-4 h-4 rounded border-slate-300 text-hui-primary focus:ring-hui-primary/20"
                                    />
                                    <span className="font-semibold text-hui-textMain">Project</span>
                                </label>
                                <div className="relative w-48">
                                    <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
                                    <input type="text" placeholder="Search Projects" value={projectSearch} onChange={e => setProjectSearch(e.target.value)}
                                        className="w-full pl-8 pr-3 py-1.5 border border-hui-border rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-hui-primary/20"
                                    />
                                </div>
                            </div>

                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="text-left text-xs font-semibold text-slate-500 uppercase border-b border-hui-border">
                                        <th className="py-2 w-8"></th>
                                        <th className="py-2">Project</th>
                                        <th className="py-2">Client</th>
                                        <th className="py-2">Create Date</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {filteredProjects.map(p => (
                                        <tr key={p.id} className="border-b border-hui-border/50 last:border-0 hover:bg-slate-50/50">
                                            <td className="py-2.5">
                                                <input type="checkbox"
                                                    checked={isAdmin || accessProjectIds.has(p.id)}
                                                    onChange={() => toggleProjectAccess(p.id)}
                                                    disabled={isAdmin}
                                                    className="w-4 h-4 rounded border-slate-300 text-hui-primary focus:ring-hui-primary/20"
                                                />
                                            </td>
                                            <td className="py-2.5 font-medium text-hui-primary">{p.name}</td>
                                            <td className="py-2.5 text-slate-500">{p.client?.name || "—"}</td>
                                            <td className="py-2.5 text-slate-400 text-xs">
                                                {new Date(p.createdAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
                                            </td>
                                        </tr>
                                    ))}
                                    {filteredProjects.length === 0 && (
                                        <tr><td colSpan={4} className="text-center text-slate-400 py-8">No projects found</td></tr>
                                    )}
                                </tbody>
                            </table>
                        </div>
                    )}

                    {/* NOTIFICATIONS TAB */}
                    {activeTab === "notifications" && (
                        <p className="text-sm text-slate-400 py-8 text-center">Notification preferences coming soon.</p>
                    )}
                </div>
            </div>

            {/* Save / Actions */}
            <div className="flex items-center justify-between mt-6">
                <div className="flex gap-3">
                    <button onClick={handleDisable}
                        className="flex items-center gap-2 text-sm font-medium text-slate-500 hover:text-slate-700 border border-hui-border rounded-lg px-4 py-2 transition"
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="m4.93 4.93 14.14 14.14"/></svg>
                        {user.status === "DISABLED" ? "Enable" : "Disable"} Team Member
                    </button>
                    <button onClick={handleDelete}
                        className="flex items-center gap-2 text-sm font-medium text-red-500 hover:text-red-700 bg-red-50 border border-red-200 rounded-lg px-4 py-2 transition"
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                        Delete Team Member
                    </button>
                </div>
                <button onClick={handleSave} disabled={saving}
                    className="bg-hui-primary text-white px-6 py-2.5 rounded-lg text-sm font-semibold hover:bg-indigo-700 transition disabled:opacity-50 shadow-sm"
                >
                    {saving ? "Saving…" : "Save Changes"}
                </button>
            </div>
        </div>
    );
}
