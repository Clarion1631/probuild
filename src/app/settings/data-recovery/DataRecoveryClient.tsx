"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2, RotateCcw, History, Building2, UserRound, Hammer, FileText } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { restoreTrashItem } from "@/lib/actions";
import type { TrashItem, AuditEntry } from "@/lib/soft-delete";

const ENTITY_META: Record<string, { label: string; badge: string; icon: React.ReactNode }> = {
    Client: { label: "Client", badge: "bg-purple-100 text-purple-700", icon: <Building2 className="w-4 h-4" /> },
    Lead: { label: "Lead", badge: "bg-blue-100 text-blue-700", icon: <UserRound className="w-4 h-4" /> },
    Project: { label: "Project", badge: "bg-amber-100 text-amber-700", icon: <Hammer className="w-4 h-4" /> },
    Estimate: { label: "Estimate", badge: "bg-green-100 text-green-700", icon: <FileText className="w-4 h-4" /> },
};

const ACTION_STYLES: Record<string, string> = {
    CREATE: "bg-green-100 text-green-700",
    UPDATE: "bg-blue-100 text-blue-700",
    DELETE: "bg-red-100 text-red-700",
    RESTORE: "bg-purple-100 text-purple-700",
};

function StatCard({ label, value }: { label: string; value: string | number }) {
    return (
        <div className="hui-card p-5">
            <p className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">{label}</p>
            <p className="text-2xl font-bold text-hui-textMain mt-1">{value}</p>
        </div>
    );
}

function TabButton({ active, onClick, count, children }: { active: boolean; onClick: () => void; count?: number; children: React.ReactNode }) {
    return (
        <button
            onClick={onClick}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition ${active ? "border-hui-primary text-hui-primary" : "border-transparent text-hui-textMuted hover:text-hui-textMain"}`}
        >
            {children}
            {count !== undefined && (
                <span className={`ml-1.5 text-xs px-1.5 py-0.5 rounded-full ${active ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-600"}`}>
                    {count}
                </span>
            )}
        </button>
    );
}

function EmptyState({ icon, title, description }: { icon: React.ReactNode; title: string; description: string }) {
    return (
        <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="w-16 h-16 bg-slate-100 rounded-2xl flex items-center justify-center mb-4 text-hui-textMuted">{icon}</div>
            <h3 className="text-base font-semibold text-hui-textMain">{title}</h3>
            <p className="text-sm text-hui-textMuted mt-1 max-w-md">{description}</p>
        </div>
    );
}

function relativeTime(iso: string): string {
    try {
        return formatDistanceToNow(new Date(iso), { addSuffix: true });
    } catch {
        return iso;
    }
}

export default function DataRecoveryClient({ initialTrash, initialAudit }: { initialTrash: TrashItem[]; initialAudit: AuditEntry[] }) {
    const router = useRouter();
    const [tab, setTab] = useState<"trash" | "audit">("trash");
    const [trash, setTrash] = useState<TrashItem[]>(initialTrash);
    const [restoringId, setRestoringId] = useState<string | null>(null);
    const [, startTransition] = useTransition();

    const counts = {
        Client: trash.filter((t) => t.entity === "Client").length,
        Lead: trash.filter((t) => t.entity === "Lead").length,
        Project: trash.filter((t) => t.entity === "Project").length,
        Estimate: trash.filter((t) => t.entity === "Estimate").length,
    };

    function handleRestore(item: TrashItem) {
        setRestoringId(item.id);
        startTransition(async () => {
            const res = await restoreTrashItem(item.entity, item.id);
            if (res.success) {
                setTrash((prev) => prev.filter((t) => t.id !== item.id));
                toast.success(`${ENTITY_META[item.entity]?.label ?? item.entity} "${item.label}" restored`);
                router.refresh();
            } else {
                toast.error(res.error ?? "Restore failed");
            }
            setRestoringId(null);
        });
    }

    return (
        <div className="max-w-6xl mx-auto py-8 px-6">
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
                <div>
                    <h1 className="text-xl font-bold text-hui-textMain">Data Recovery</h1>
                    <p className="text-sm text-hui-textMuted mt-1">
                        Restore deleted customer records and review the audit trail. Deletions are reversible — nothing is permanently removed here.
                    </p>
                </div>
            </div>

            {/* Stat Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                <StatCard label="In Trash" value={trash.length} />
                <StatCard label="Clients" value={counts.Client} />
                <StatCard label="Leads / Projects" value={counts.Lead + counts.Project} />
                <StatCard label="Estimates" value={counts.Estimate} />
            </div>

            {/* Tabs */}
            <div className="flex items-center gap-1 mb-4 border-b border-hui-border">
                <TabButton active={tab === "trash"} onClick={() => setTab("trash")} count={trash.length}>Trash</TabButton>
                <TabButton active={tab === "audit"} onClick={() => setTab("audit")} count={initialAudit.length}>Audit History</TabButton>
            </div>

            {tab === "trash" ? (
                <div className="hui-card">
                    {trash.length === 0 ? (
                        <EmptyState
                            icon={<Trash2 className="w-7 h-7" />}
                            title="Trash is empty"
                            description="Deleted clients, leads, projects, and estimates will appear here, ready to restore."
                        />
                    ) : (
                        <table className="w-full">
                            <thead>
                                <tr className="border-b border-hui-border bg-slate-50">
                                    <th className="text-left px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Type</th>
                                    <th className="text-left px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Name</th>
                                    <th className="text-left px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Details</th>
                                    <th className="text-left px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Deleted</th>
                                    <th className="text-right px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Action</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                                {trash.map((item) => {
                                    const meta = ENTITY_META[item.entity];
                                    return (
                                        <tr key={`${item.entity}-${item.id}`} className="hover:bg-slate-50 transition">
                                            <td className="px-4 py-3">
                                                <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2 py-0.5 rounded-full ${meta?.badge ?? "bg-slate-100 text-slate-700"}`}>
                                                    {meta?.icon}
                                                    {meta?.label ?? item.entity}
                                                </span>
                                            </td>
                                            <td className="px-4 py-3 text-sm font-medium text-hui-textMain">{item.label}</td>
                                            <td className="px-4 py-3 text-sm text-hui-textMuted">{item.sublabel}</td>
                                            <td className="px-4 py-3 text-xs text-hui-textMuted">{relativeTime(item.deletedAt)}</td>
                                            <td className="px-4 py-3 text-right">
                                                <button
                                                    onClick={() => handleRestore(item)}
                                                    disabled={restoringId === item.id}
                                                    className="hui-btn hui-btn-secondary inline-flex items-center gap-1.5 text-sm disabled:opacity-50"
                                                >
                                                    <RotateCcw className="w-3.5 h-3.5" />
                                                    {restoringId === item.id ? "Restoring..." : "Restore"}
                                                </button>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    )}
                </div>
            ) : (
                <div className="hui-card">
                    {initialAudit.length === 0 ? (
                        <EmptyState
                            icon={<History className="w-7 h-7" />}
                            title="No audit history yet"
                            description="Create, update, delete, and restore events for customer records will be logged here."
                        />
                    ) : (
                        <table className="w-full">
                            <thead>
                                <tr className="border-b border-hui-border bg-slate-50">
                                    <th className="text-left px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">When</th>
                                    <th className="text-left px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Action</th>
                                    <th className="text-left px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Record</th>
                                    <th className="text-left px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">By</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                                {initialAudit.map((entry) => (
                                    <tr key={entry.id} className="hover:bg-slate-50 transition">
                                        <td className="px-4 py-3 text-xs text-hui-textMuted" title={new Date(entry.createdAt).toLocaleString()}>{relativeTime(entry.createdAt)}</td>
                                        <td className="px-4 py-3">
                                            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${ACTION_STYLES[entry.action] ?? "bg-slate-100 text-slate-700"}`}>
                                                {entry.action}
                                            </span>
                                        </td>
                                        <td className="px-4 py-3 text-sm text-hui-textMain">
                                            <span className="font-medium">{entry.entity}</span>
                                            <span className="text-hui-textMuted text-xs ml-1.5 font-mono">{entry.entityId.slice(0, 10)}…</span>
                                        </td>
                                        <td className="px-4 py-3 text-sm text-hui-textMuted">{entry.actorEmail ?? "—"}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>
            )}
        </div>
    );
}
