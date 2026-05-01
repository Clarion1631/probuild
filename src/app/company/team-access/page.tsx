"use client";

import { useState, useEffect } from "react";
import { toast } from "sonner";

interface Project {
    id: string;
    name: string;
    client: { name: string } | null;
    createdAt: string;
}

interface UserSummary {
    id: string;
    name: string | null;
    email: string;
    role: string;
    status: string;
    permissions: { autoGrantNewProjects?: boolean } | null;
    projectAccess: { projectId: string }[];
    assignedProjects?: { id: string }[];
}

interface UserDetail {
    id: string;
    name: string | null;
    email: string;
    role: string;
    permissions: { autoGrantNewProjects?: boolean } | null;
    projectAccess: { projectId: string; project: Project }[];
}

export default function TeamAccessPage() {
    const [users, setUsers] = useState<UserSummary[]>([]);
    const [allProjects, setAllProjects] = useState<Project[]>([]);
    const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
    const [selectedUser, setSelectedUser] = useState<UserDetail | null>(null);
    const [assignedIds, setAssignedIds] = useState<string[]>([]);
    const [autoGrant, setAutoGrant] = useState(true);
    const [loading, setLoading] = useState(true);
    const [loadingDetail, setLoadingDetail] = useState(false);
    const [saving, setSaving] = useState(false);
    const [userSearch, setUserSearch] = useState("");
    const [projectSearch, setProjectSearch] = useState("");

    useEffect(() => {
        fetchUsers();
    }, []);

    async function fetchUsers() {
        try {
            const res = await fetch("/api/users");
            if (res.ok) {
                const data = await res.json();
                setUsers(data);
            }
        } catch {
            toast.error("Failed to load team members");
        } finally {
            setLoading(false);
        }
    }

    async function selectUser(userId: string) {
        setSelectedUserId(userId);
        setLoadingDetail(true);
        try {
            const res = await fetch(`/api/users/${userId}`);
            if (res.ok) {
                const { user, allProjects: projects } = await res.json();
                setSelectedUser(user);
                setAllProjects(projects || []);
                const accessIds = user.projectAccess?.map((pa: any) => pa.project?.id || pa.projectId).filter(Boolean) || [];
                const crewIds = user.assignedProjects?.map((p: any) => p.id) || [];
                setAssignedIds([...new Set([...accessIds, ...crewIds])]);
                setAutoGrant(user.permissions?.autoGrantNewProjects ?? true);
            }
        } catch {
            toast.error("Failed to load user details");
        } finally {
            setLoadingDetail(false);
        }
    }

    const saveProjectAccess = async (newIds: string[], prevIds: string[]) => {
        if (!selectedUserId) return;
        setSaving(true);
        try {
            const res = await fetch(`/api/users/${selectedUserId}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ projectIds: newIds }),
            });
            if (!res.ok) throw new Error();
            toast.success("Project access updated");
            setUsers((prev) =>
                prev.map((u) =>
                    u.id === selectedUserId
                        ? {
                              ...u,
                              projectAccess: newIds.map((pid) => ({ projectId: pid })),
                              assignedProjects: newIds.map((pid) => ({ id: pid })),
                          }
                        : u
                )
            );
        } catch {
            toast.error("Failed to update access");
            setAssignedIds(prevIds);
        } finally {
            setSaving(false);
        }
    };

    const handleToggle = (projectId: string, isChecked: boolean) => {
        const prevIds = assignedIds;
        const newIds = isChecked
            ? [...assignedIds, projectId]
            : assignedIds.filter((id) => id !== projectId);
        setAssignedIds(newIds);
        saveProjectAccess(newIds, prevIds);
    };

    const handleGrantAll = () => {
        const prevIds = assignedIds;
        const allIds = allProjects.map((p) => p.id);
        setAssignedIds(allIds);
        saveProjectAccess(allIds, prevIds);
    };

    const handleRevokeAll = () => {
        const prevIds = assignedIds;
        setAssignedIds([]);
        saveProjectAccess([], prevIds);
    };

    const handleAutoGrantToggle = async () => {
        if (!selectedUserId) return;
        const newVal = !autoGrant;
        setAutoGrant(newVal);
        try {
            const res = await fetch(`/api/users/${selectedUserId}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ permissions: { autoGrantNewProjects: newVal } }),
            });
            if (!res.ok) throw new Error();
            toast.success(newVal ? "Auto-assign enabled" : "Auto-assign disabled");
        } catch {
            toast.error("Failed to update setting");
            setAutoGrant(!newVal);
        }
    };

    const filteredUsers = users.filter(
        (u) =>
            (u.name?.toLowerCase() || "").includes(userSearch.toLowerCase()) ||
            u.email.toLowerCase().includes(userSearch.toLowerCase())
    );

    const filteredProjects = allProjects.filter(
        (p) =>
            p.name.toLowerCase().includes(projectSearch.toLowerCase()) ||
            (p.client?.name && p.client.name.toLowerCase().includes(projectSearch.toLowerCase()))
    );

    const isAutoAccessRole = selectedUser && (selectedUser.role === "ADMIN" || selectedUser.role === "MANAGER");

    const getRoleBadge = (role: string) => {
        const styles: Record<string, string> = {
            ADMIN: "bg-purple-100 text-purple-700",
            MANAGER: "bg-blue-100 text-blue-700",
            FINANCE: "bg-green-100 text-green-700",
            FIELD_CREW: "bg-slate-100 text-slate-600",
        };
        const labels: Record<string, string> = {
            ADMIN: "Admin",
            MANAGER: "Manager",
            FINANCE: "Finance",
            FIELD_CREW: "Crew",
        };
        return (
            <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${styles[role] || styles.FIELD_CREW}`}>
                {labels[role] || "Crew"}
            </span>
        );
    };

    if (loading) return <div className="p-8 text-center text-hui-textMuted">Loading...</div>;

    return (
        <div className="flex flex-col h-full overflow-hidden bg-hui-background">
            <header className="bg-white border-b border-hui-border px-8 py-4 shrink-0">
                <h1 className="text-xl font-bold text-hui-textMain">Team Project Access</h1>
                <p className="text-sm text-hui-textMuted mt-1">
                    Manage which projects each team member can access in the mobile app.
                </p>
            </header>

            <div className="flex flex-1 overflow-hidden">
                {/* Left: User list */}
                <div className="w-80 border-r border-hui-border bg-white flex flex-col shrink-0">
                    <div className="p-4 border-b border-hui-border">
                        <input
                            type="text"
                            placeholder="Search team members..."
                            value={userSearch}
                            onChange={(e) => setUserSearch(e.target.value)}
                            className="hui-input w-full text-sm"
                        />
                    </div>
                    <div className="flex-1 overflow-y-auto">
                        {filteredUsers.map((u) => (
                            <button
                                key={u.id}
                                onClick={() => selectUser(u.id)}
                                className={`w-full text-left px-4 py-3 border-b border-slate-100 hover:bg-slate-50 transition ${
                                    selectedUserId === u.id ? "bg-blue-50 border-l-2 border-l-blue-500" : ""
                                }`}
                            >
                                <div className="flex items-center justify-between">
                                    <div className="min-w-0">
                                        <div className="flex items-center gap-2">
                                            <span className="text-sm font-medium text-hui-textMain truncate">
                                                {u.name || "Invited User"}
                                            </span>
                                            {getRoleBadge(u.role)}
                                        </div>
                                        <div className="text-xs text-hui-textMuted truncate">{u.email}</div>
                                    </div>
                                    <span className="text-xs text-slate-400 ml-2 shrink-0">
                                        {u.role === "ADMIN" || u.role === "MANAGER"
                                            ? "All"
                                            : new Set([
                                                ...(u.projectAccess?.map(pa => pa.projectId) || []),
                                                ...(u.assignedProjects?.map(p => p.id) || []),
                                            ]).size}
                                    </span>
                                </div>
                            </button>
                        ))}
                    </div>
                </div>

                {/* Right: Project access */}
                <div className="flex-1 overflow-y-auto p-8">
                    {!selectedUserId ? (
                        <div className="flex items-center justify-center h-full text-hui-textMuted">
                            Select a team member to manage their project access.
                        </div>
                    ) : loadingDetail ? (
                        <div className="flex items-center justify-center h-full text-hui-textMuted">
                            Loading...
                        </div>
                    ) : selectedUser ? (
                        <div className="max-w-3xl">
                            <div className="flex items-center gap-3 mb-6">
                                <div className="w-10 h-10 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center font-bold text-sm">
                                    {(selectedUser.name || selectedUser.email).substring(0, 2).toUpperCase()}
                                </div>
                                <div>
                                    <h2 className="text-lg font-semibold text-hui-textMain">
                                        {selectedUser.name || selectedUser.email}
                                    </h2>
                                    <p className="text-sm text-hui-textMuted">{selectedUser.email}</p>
                                </div>
                                {getRoleBadge(selectedUser.role)}
                            </div>

                            {isAutoAccessRole ? (
                                <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-800">
                                    Admins and Managers have automatic access to all projects. No manual
                                    assignment needed.
                                </div>
                            ) : (
                                <>
                                    {/* Auto-grant toggle */}
                                    <label className="flex items-center gap-3 mb-4 p-3 bg-slate-50 rounded-lg border border-slate-200 cursor-pointer select-none">
                                        <input
                                            type="checkbox"
                                            checked={autoGrant}
                                            onChange={handleAutoGrantToggle}
                                            className="w-4 h-4 text-hui-primary border-slate-300 rounded focus:ring-hui-primary/20"
                                        />
                                        <div>
                                            <span className="text-sm font-medium text-hui-textMain">
                                                Automatically add to new projects
                                            </span>
                                            <p className="text-xs text-slate-500">
                                                This user will automatically receive access to any newly created project.
                                            </p>
                                        </div>
                                    </label>

                                    {/* Quick actions */}
                                    <div className="flex items-center gap-3 mb-4">
                                        <button
                                            onClick={handleGrantAll}
                                            disabled={saving}
                                            className="text-xs font-medium text-blue-600 hover:text-blue-800 disabled:opacity-50"
                                        >
                                            Grant All ({allProjects.length})
                                        </button>
                                        <span className="text-slate-300">|</span>
                                        <button
                                            onClick={handleRevokeAll}
                                            disabled={saving}
                                            className="text-xs font-medium text-red-600 hover:text-red-800 disabled:opacity-50"
                                        >
                                            Revoke All
                                        </button>
                                        <span className="ml-auto text-xs text-slate-500">
                                            {assignedIds.length} / {allProjects.length} projects assigned
                                        </span>
                                    </div>

                                    {/* Search */}
                                    <div className="relative mb-4">
                                        <svg
                                            className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400"
                                            fill="none"
                                            stroke="currentColor"
                                            strokeWidth="2"
                                            viewBox="0 0 24 24"
                                        >
                                            <circle cx="11" cy="11" r="8" />
                                            <path d="m21 21-4.35-4.35" />
                                        </svg>
                                        <input
                                            type="text"
                                            placeholder="Search projects..."
                                            value={projectSearch}
                                            onChange={(e) => setProjectSearch(e.target.value)}
                                            className="w-full pl-9 pr-4 py-2 border border-hui-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-hui-primary/20 bg-white"
                                        />
                                    </div>

                                    {/* Project table */}
                                    <div className="border border-slate-200 rounded-lg overflow-hidden max-h-[500px] overflow-y-auto">
                                        <table className="w-full">
                                            <thead className="bg-slate-50 sticky top-0 border-b border-slate-200">
                                                <tr className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">
                                                    <th className="px-4 py-3 w-10"></th>
                                                    <th className="px-4 py-3">Project</th>
                                                    <th className="px-4 py-3">Client</th>
                                                    <th className="px-4 py-3 text-right">Created</th>
                                                </tr>
                                            </thead>
                                            <tbody className="divide-y divide-slate-100">
                                                {filteredProjects.length === 0 ? (
                                                    <tr>
                                                        <td
                                                            colSpan={4}
                                                            className="text-center py-8 text-sm text-slate-400 italic"
                                                        >
                                                            No projects found
                                                        </td>
                                                    </tr>
                                                ) : (
                                                    filteredProjects.map((p) => (
                                                        <tr
                                                            key={p.id}
                                                            className="hover:bg-slate-50/50 transition"
                                                        >
                                                            <td className="px-4 py-3">
                                                                <input
                                                                    type="checkbox"
                                                                    checked={assignedIds.includes(p.id)}
                                                                    onChange={(e) =>
                                                                        handleToggle(p.id, e.target.checked)
                                                                    }
                                                                    disabled={saving}
                                                                    className="w-4 h-4 text-hui-primary border-slate-300 rounded focus:ring-hui-primary/20"
                                                                />
                                                            </td>
                                                            <td className="px-4 py-3 text-sm font-medium text-slate-700">
                                                                {p.name}
                                                            </td>
                                                            <td className="px-4 py-3 text-sm text-slate-500">
                                                                {p.client?.name || "—"}
                                                            </td>
                                                            <td className="px-4 py-3 text-sm text-slate-500 text-right">
                                                                {new Date(p.createdAt).toLocaleDateString()}
                                                            </td>
                                                        </tr>
                                                    ))
                                                )}
                                            </tbody>
                                        </table>
                                    </div>
                                </>
                            )}
                        </div>
                    ) : null}
                </div>
            </div>
        </div>
    );
}
