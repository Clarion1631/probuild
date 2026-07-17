"use client";

import { useState } from "react";
import { toast } from "sonner";

interface Project {
    id: string;
    name: string;
    client: { name: string } | null;
    createdAt: string;
}

interface TeamMemberProjectAccessProps {
    userId: string;
    userRole: string;
    initialProjectIds: string[];
    allProjects: Project[];
    autoGrantNewProjects: boolean;
}

export default function TeamMemberProjectAccess({
    userId,
    userRole,
    initialProjectIds,
    allProjects,
    autoGrantNewProjects: initialAutoGrant,
}: TeamMemberProjectAccessProps) {
    const [assignedIds, setAssignedIds] = useState<string[]>(initialProjectIds);
    const [autoGrant, setAutoGrant] = useState(initialAutoGrant);
    const [saving, setSaving] = useState(false);
    const [search, setSearch] = useState("");

    const isAutoAccessRole = userRole === "ADMIN" || userRole === "MANAGER";

    const saveProjectAccess = async (newIds: string[], prevIds: string[]) => {
        setSaving(true);
        try {
            const res = await fetch(`/api/users/${userId}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ projectIds: newIds }),
            });
            if (!res.ok) throw new Error();
            toast.success("Project access updated");
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
        const newVal = !autoGrant;
        setAutoGrant(newVal);
        try {
            const res = await fetch(`/api/users/${userId}`, {
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

    const filtered = allProjects.filter(
        (p) =>
            p.name.toLowerCase().includes(search.toLowerCase()) ||
            (p.client?.name && p.client.name.toLowerCase().includes(search.toLowerCase()))
    );

    return (
        <div className="hui-card p-6">
            <h3 className="text-sm font-semibold text-hui-textMain mb-2 uppercase tracking-wider">
                Project Access
            </h3>
            <p className="text-xs text-slate-500 mb-4">
                Control which projects this team member can see in the mobile app.
            </p>

            {isAutoAccessRole ? (
                <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-800">
                    Admins and Managers have automatic access to all projects. No manual assignment
                    needed.
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
                                When enabled, this user will automatically receive access to any newly
                                created project.
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
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            className="w-full pl-9 pr-4 py-2 border border-hui-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-hui-primary/20 bg-white"
                        />
                    </div>

                    {/* Project table */}
                    <div className="border border-slate-200 rounded-lg overflow-hidden max-h-[400px] overflow-y-auto">
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
                                {filtered.length === 0 ? (
                                    <tr>
                                        <td
                                            colSpan={4}
                                            className="text-center py-8 text-sm text-slate-400 italic"
                                        >
                                            No projects found
                                        </td>
                                    </tr>
                                ) : (
                                    filtered.map((p) => (
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
    );
}
