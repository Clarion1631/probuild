"use client";

import { useState, useEffect, useRef } from "react";
import { updateLeadAssignment, updateProjectManager } from "@/lib/actions";
import { toast } from "sonner";

interface ManagerAssignRowProps {
    entityType: "lead" | "project";
    entityId: string;
    currentManagerId: string | null;
    currentManagerName: string | null;
}

interface User {
    id: string;
    name: string | null;
    email: string;
    role: string;
}

export default function ManagerAssignRow({
    entityType, entityId, currentManagerId, currentManagerName,
}: ManagerAssignRowProps) {
    const [managerId, setManagerId] = useState(currentManagerId);
    const [managerName, setManagerName] = useState(currentManagerName);
    const [open, setOpen] = useState(false);
    const [users, setUsers] = useState<User[]>([]);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [search, setSearch] = useState("");
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        function handleClick(e: MouseEvent) {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        }
        document.addEventListener("mousedown", handleClick);
        return () => document.removeEventListener("mousedown", handleClick);
    }, []);

    const openDropdown = async () => {
        if (!open && users.length === 0) {
            setLoading(true);
            try {
                const res = await fetch("/api/users");
                if (res.ok) {
                    const data = await res.json();
                    setUsers(data.filter((u: User) => ["ADMIN", "MANAGER"].includes(u.role)));
                }
            } finally {
                setLoading(false);
            }
        }
        setOpen(v => !v);
    };

    const assign = async (user: User | null) => {
        setSaving(true);
        try {
            if (entityType === "lead") {
                await updateLeadAssignment(entityId, user?.id ?? null);
            } else {
                await updateProjectManager(entityId, user?.id ?? null);
            }
            setManagerId(user?.id ?? null);
            setManagerName(user?.name || user?.email || null);
            toast.success(user ? `Assigned to ${user.name || user.email}` : "Manager removed");
        } catch {
            toast.error("Failed to assign manager");
        } finally {
            setSaving(false);
            setOpen(false);
            setSearch("");
        }
    };

    const filtered = users.filter(u =>
        (u.name || u.email).toLowerCase().includes(search.toLowerCase())
    );

    const initials = managerName
        ? managerName.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase()
        : null;

    return (
        <div className="flex items-center justify-between py-2 border-b border-slate-50" ref={ref}>
            <span className="text-sm text-slate-600">Manager</span>
            <div className="relative">
                <button
                    onClick={openDropdown}
                    disabled={saving}
                    className="flex items-center gap-1.5 text-sm hover:opacity-80 transition"
                >
                    {initials ? (
                        <div className="w-6 h-6 rounded-full bg-blue-500 flex items-center justify-center text-[9px] font-bold text-white">
                            {initials}
                        </div>
                    ) : (
                        <div className="w-6 h-6 rounded-full bg-slate-200 flex items-center justify-center">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2">
                                <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/>
                                <circle cx="12" cy="7" r="4"/>
                            </svg>
                        </div>
                    )}
                    <span className={managerName ? "text-slate-700 font-medium" : "text-green-600 font-medium"}>
                        {managerName || "Assign"}
                    </span>
                </button>

                {open && (
                    <div className="absolute right-0 top-8 z-50 w-52 bg-white rounded-lg shadow-xl border border-slate-200 overflow-hidden">
                        <div className="p-2 border-b border-slate-100">
                            <input
                                type="text"
                                placeholder="Search..."
                                value={search}
                                onChange={e => setSearch(e.target.value)}
                                className="w-full px-2 py-1 text-xs border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-blue-400"
                                autoFocus
                            />
                        </div>
                        <div className="max-h-48 overflow-y-auto">
                            {loading ? (
                                <div className="p-3 text-xs text-slate-400 text-center">Loading...</div>
                            ) : (
                                <>
                                    {managerId && (
                                        <button
                                            onClick={() => assign(null)}
                                            className="w-full text-left px-3 py-2 text-xs text-red-500 hover:bg-red-50 transition"
                                        >
                                            Remove manager
                                        </button>
                                    )}
                                    {filtered.map(u => (
                                        <button
                                            key={u.id}
                                            onClick={() => assign(u)}
                                            className={`w-full text-left px-3 py-2 text-xs hover:bg-slate-50 transition flex items-center gap-2 ${
                                                u.id === managerId ? "bg-blue-50" : ""
                                            }`}
                                        >
                                            <div className="w-5 h-5 rounded-full bg-blue-100 flex items-center justify-center text-[9px] font-bold text-blue-700 shrink-0">
                                                {(u.name || u.email).slice(0, 2).toUpperCase()}
                                            </div>
                                            <div className="min-w-0">
                                                <p className="font-medium text-slate-800 truncate">{u.name || u.email}</p>
                                                <p className="text-slate-400 truncate">{u.role}</p>
                                            </div>
                                        </button>
                                    ))}
                                    {filtered.length === 0 && !loading && (
                                        <div className="p-3 text-xs text-slate-400 text-center">No managers found</div>
                                    )}
                                </>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
