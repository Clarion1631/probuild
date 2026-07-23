"use client";

// Extracted out of CompanyDashboardClient.tsx (item 1) so ProjectBar.tsx and
// TaskBlockSegment.tsx can reuse the SAME crew pickers inside the new
// context-menu "Project crew…" / "Task crew…" items, without a circular
// import (CompanyDashboardClient -> ScheduleBoard -> …View -> ProjectBar
// would import back into CompanyDashboardClient otherwise). Behavior is
// byte-identical to the original inline components.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { DashboardTaskRow, PipelineCrewMember } from "@/lib/schedule-core";
import { updateProjectCrewAction, updateTaskCrewAction } from "@/lib/actions";

function initials(name: string): string {
    const parts = name.trim().split(/\s+/);
    return parts.map(p => p[0]).join("").toUpperCase().slice(0, 2) || "?";
}

// Compact crew picker (checkbox popover) — the list is pre-filtered to
// ACTIVATED users server-side; every toggle replaces the crew idempotently.
export function CrewPicker({
    projectId,
    crew,
    teamMembers,
}: {
    projectId: string;
    crew: PipelineCrewMember[];
    teamMembers: { id: string; name: string; email: string }[];
}) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [isPending, startTransition] = useTransition();

    // Selection mirrors the server crew unless the user just toggled (the
    // override keys on the crew contents, so refreshed props take back over).
    const crewKey = crew.map(c => c.id).sort().join(",");
    const [override, setOverride] = useState<{ key: string; ids: string[] } | null>(null);
    const selected = override && override.key === crewKey ? override.ids : crew.map(c => c.id);

    function toggle(userId: string) {
        const next = selected.includes(userId) ? selected.filter(id => id !== userId) : [...selected, userId];
        setOverride({ key: crewKey, ids: next });
        startTransition(async () => {
            try {
                await updateProjectCrewAction(projectId, next);
                router.refresh();
            } catch (err: any) {
                toast.error(err?.message || "Failed to update crew");
                setOverride(null);
            }
        });
    }

    // Option list: the picker team list PLUS any currently-assigned member who
    // isn't in it — either because they're no longer ACTIVATED (removable
    // "(inactive)" entry) or because they're a FINANCE user excluded from the
    // picker (removable "(finance)" entry). Checked by default (they ARE
    // assigned); unchecking them before saving removes them (the core
    // validates only newly-ADDED members against ACTIVATED).
    const unlistedAssigned = crew.filter(c => !teamMembers.some(m => m.id === c.id));
    const options = [
        ...teamMembers.map(m => ({ id: m.id, label: m.name || m.email })),
        ...unlistedAssigned.map(c => ({ id: c.id, label: `${c.name} (${c.role === "FINANCE" ? "finance" : "inactive"})` })),
    ];
    const selectedNames = options.filter(o => selected.includes(o.id));
    return (
        <div className="relative">
            <button
                type="button"
                onClick={() => setOpen(o => !o)}
                disabled={isPending}
                className="hui-btn hui-btn-secondary text-xs px-2 py-1"
                title="Assign crew"
            >
                {selectedNames.length === 0 ? "Assign crew" : selectedNames.map(o => initials(o.label)).join(" ")}
            </button>
            {open && (
                <>
                    <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
                    <div className="absolute z-30 mt-1 w-56 bg-white border border-hui-border rounded-lg shadow-lg p-2 max-h-64 overflow-y-auto">
                        {options.length === 0 && <p className="text-xs text-hui-textMuted px-2 py-1">No active team members.</p>}
                        {options.map(o => (
                            <label key={o.id} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-slate-50 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={selected.includes(o.id)}
                                    onChange={() => toggle(o.id)}
                                    className="accent-hui-primary"
                                />
                                <span className="text-sm text-hui-textMain">{o.label}</span>
                            </label>
                        ))}
                    </div>
                </>
            )}
        </div>
    );
}

export function TaskCrewPicker({ task, teamMembers }: { task: DashboardTaskRow; teamMembers: { id: string; name: string; email: string }[] }) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [isPending, startTransition] = useTransition();
    const assignedIds = task.assignments.map(a => a.userId);
    const assignmentKey = [...assignedIds].sort().join(",");
    const [override, setOverride] = useState<{ key: string; ids: string[] } | null>(null);
    const selected = override?.key === assignmentKey ? override.ids : assignedIds;
    const unlisted = task.assignments.filter(a => !teamMembers.some(m => m.id === a.userId));
    const options = [
        ...teamMembers.map(member => ({ id: member.id, label: member.name || member.email })),
        ...unlisted.map(a => ({ id: a.userId, label: `${a.name} (${a.role === "FINANCE" ? "finance" : "inactive"})` })),
    ];

    function toggle(userId: string) {
        const next = selected.includes(userId) ? selected.filter(id => id !== userId) : [...selected, userId];
        setOverride({ key: assignmentKey, ids: next });
        startTransition(async () => {
            try {
                await updateTaskCrewAction(task.id, next);
                router.refresh();
            } catch (err: any) {
                toast.error(err?.message || "Failed to update task crew");
                setOverride(null);
            }
        });
    }

    return (
        <div className="relative inline-block">
            <button type="button" onClick={() => setOpen(value => !value)} disabled={isPending} className="hui-btn hui-btn-secondary text-xs px-2 py-1" aria-expanded={open}>
                {selected.length === 0 ? "Assign task crew" : task.assignments.filter(a => selected.includes(a.userId)).map(a => initials(a.name)).join(" ") || `${selected.length} assigned`}
            </button>
            {open && (
                <>
                    <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
                    <div className="absolute right-0 z-30 mt-1 w-56 bg-white border border-hui-border rounded-lg shadow-lg p-2 max-h-64 overflow-y-auto">
                        {options.length === 0 && <p className="text-xs text-hui-textMuted px-2 py-1">No active team members.</p>}
                        {options.map(option => (
                            <label key={option.id} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-slate-50 cursor-pointer">
                                <input type="checkbox" checked={selected.includes(option.id)} onChange={() => toggle(option.id)} className="accent-hui-primary" />
                                <span className="text-sm text-hui-textMain">{option.label}</span>
                            </label>
                        ))}
                    </div>
                </>
            )}
        </div>
    );
}
