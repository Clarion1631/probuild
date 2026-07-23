"use client";

// Extracted out of CompanyDashboardClient.tsx (item 1) so ProjectBar.tsx and
// TaskBlockSegment.tsx can reuse the SAME crew pickers inside the new
// context-menu "Project crew…" / "Task crew…" items, without a circular
// import (CompanyDashboardClient -> ScheduleBoard -> …View -> ProjectBar
// would import back into CompanyDashboardClient otherwise). Behavior is
// byte-identical to the original inline components.
//
// Rebuild (owner-feedback round, item 5): the picker used to bring its own
// fixed-width, fixed-height, self-scrolling inner panel, nested inside the
// schedule board's ALREADY-scrollable FloatingPopover menus (ProjectBar/
// TaskBlockSegment's "crew" view) — a double scrollbar + horizontal overflow.
// CrewChecklist is now a plain two-column grid with NO scroll/width of its
// own — FloatingPopover is the one and only scroll owner everywhere a picker
// renders.

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { DashboardTaskRow, PipelineCrewMember } from "@/lib/schedule-core";
import { updateProjectCrewAction, updateTaskCrewAction } from "@/lib/actions";
import { FloatingPopover } from "./FloatingPopover";

function initials(name: string): string {
    const parts = name.trim().split(/\s+/);
    return parts.map(p => p[0]).join("").toUpperCase().slice(0, 2) || "?";
}

interface CrewOption {
    id: string;
    label: string;
}

// Shared checklist presentation — used both `variant="inline"` (rendered
// directly inside an ALREADY-open schedule-board FloatingPopover, no nested
// popover of its own) and `variant="popover"` (the Schedule & crew table's
// own trigger + FloatingPopover). No selected-initials chip here — the
// table/bar trigger button keeps summarizing initials on its own.
// Serializes full-list crew writes: instant optimistic UI, but requests go
// out strictly in order (a later toggle's list can never be overtaken by an
// earlier one racing through the locked server transaction). While one write
// is in flight, newer lists coalesce into a single queued follow-up.
function useSerializedCrewSubmit(send: (ids: string[]) => Promise<void>, onError: (message: string) => void) {
    const [isPending, startTransition] = useTransition();
    const inFlightRef = useRef(false);
    const queuedRef = useRef<string[] | null>(null);
    const submit = (ids: string[]) => {
        if (inFlightRef.current) {
            queuedRef.current = ids;
            return;
        }
        inFlightRef.current = true;
        startTransition(async () => {
            try {
                let current: string[] | null = ids;
                while (current) {
                    await send(current);
                    current = queuedRef.current;
                    queuedRef.current = null;
                }
            } catch (err: any) {
                queuedRef.current = null;
                onError(err?.message ?? "Failed to update crew");
            } finally {
                inFlightRef.current = false;
            }
        });
    };
    return { submit, isPending };
}

function CrewChecklist({
    legend,
    options,
    selected,
    onToggle,
}: {
    legend: string;
    options: CrewOption[];
    selected: string[];
    onToggle: (userId: string) => void;
}) {
    return (
        <fieldset className="m-0 min-w-0 border-0 p-0">
            <legend className="mb-1 px-0 text-[10px] font-semibold uppercase tracking-wide text-hui-textMuted">{legend}</legend>
            {options.length === 0 ? (
                <p className="px-2 py-1 text-xs text-hui-textMuted">No active team members.</p>
            ) : (
                <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                    {options.map(option => (
                        <label key={option.id} className="flex min-h-11 min-w-0 items-center gap-2 rounded-md px-2 py-2 hover:bg-slate-50 focus-within:ring-2 focus-within:ring-hui-primary">
                            <input
                                type="checkbox"
                                checked={selected.includes(option.id)}
                                onChange={() => onToggle(option.id)}
                                className="h-4 w-4 shrink-0 accent-hui-primary"
                            />
                            <span className="min-w-0 break-words text-sm text-hui-textMain">{option.label}</span>
                        </label>
                    ))}
                </div>
            )}
        </fieldset>
    );
}

// Compact crew picker — the list is pre-filtered to ACTIVATED users
// server-side; every toggle replaces the crew idempotently.
export function CrewPicker({
    projectId,
    crew,
    teamMembers,
    variant = "popover",
}: {
    projectId: string;
    crew: PipelineCrewMember[];
    teamMembers: { id: string; name: string; email: string }[];
    // "inline" (ProjectBar's "Project crew…" menu view — already inside a
    // FloatingPopover) vs "popover" (Schedule & crew table — owns its own
    // trigger + FloatingPopover).
    variant?: "inline" | "popover";
}) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const triggerRef = useRef<HTMLButtonElement>(null);


    // Selection mirrors the server crew unless the user just toggled (the
    // override keys on the crew contents, so refreshed props take back over).
    const crewKey = crew.map(c => c.id).sort().join(",");
    const [override, setOverride] = useState<{ key: string; ids: string[] } | null>(null);
    const selected = override && override.key === crewKey ? override.ids : crew.map(c => c.id);

    const { submit: submitCrew, isPending } = useSerializedCrewSubmit(
        async ids => {
            await updateProjectCrewAction(projectId, ids);
            router.refresh();
        },
        message => {
            toast.error(message || "Failed to update crew");
            setOverride(null);
        },
    );
    function toggle(userId: string) {
        const next = selected.includes(userId) ? selected.filter(id => id !== userId) : [...selected, userId];
        setOverride({ key: crewKey, ids: next });
        submitCrew(next);
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
    const legend = `Project crew — ${selected.length} assigned`;

    if (variant === "inline") {
        return <CrewChecklist legend={legend} options={options} selected={selected} onToggle={toggle} />;
    }

    const selectedNames = options.filter(o => selected.includes(o.id));
    return (
        <>
            <button
                ref={triggerRef}
                type="button"
                onClick={() => setOpen(o => !o)}
                disabled={isPending}
                aria-expanded={open}
                className="hui-btn hui-btn-secondary text-xs px-2 py-1"
                title="Assign crew"
            >
                {selectedNames.length === 0 ? "Assign crew" : selectedNames.map(o => initials(o.label)).join(" ")}
            </button>
            <FloatingPopover open={open} anchorRef={triggerRef} onClose={() => setOpen(false)} width={320}>
                <CrewChecklist legend={legend} options={options} selected={selected} onToggle={toggle} />
            </FloatingPopover>
        </>
    );
}

export function TaskCrewPicker({
    task,
    teamMembers,
    variant = "popover",
}: {
    task: DashboardTaskRow;
    teamMembers: { id: string; name: string; email: string }[];
    variant?: "inline" | "popover";
}) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const assignedIds = task.assignments.map(a => a.userId);
    const assignmentKey = [...assignedIds].sort().join(",");
    const [override, setOverride] = useState<{ key: string; ids: string[] } | null>(null);
    const selected = override?.key === assignmentKey ? override.ids : assignedIds;
    const unlisted = task.assignments.filter(a => !teamMembers.some(m => m.id === a.userId));
    const options = [
        ...teamMembers.map(member => ({ id: member.id, label: member.name || member.email })),
        ...unlisted.map(a => ({ id: a.userId, label: `${a.name} (${a.role === "FINANCE" ? "finance" : "inactive"})` })),
    ];
    const legend = `Task crew — ${selected.length} assigned`;

    const { submit: submitCrew, isPending } = useSerializedCrewSubmit(
        async ids => {
            await updateTaskCrewAction(task.id, ids);
            router.refresh();
        },
        message => {
            toast.error(message || "Failed to update task crew");
            setOverride(null);
        },
    );
    function toggle(userId: string) {
        const next = selected.includes(userId) ? selected.filter(id => id !== userId) : [...selected, userId];
        setOverride({ key: assignmentKey, ids: next });
        submitCrew(next);
    }

    if (variant === "inline") {
        return <CrewChecklist legend={legend} options={options} selected={selected} onToggle={toggle} />;
    }

    return (
        <>
            <button ref={triggerRef} type="button" onClick={() => setOpen(value => !value)} disabled={isPending} className="hui-btn hui-btn-secondary text-xs px-2 py-1" aria-expanded={open}>
                {selected.length === 0 ? "Assign task crew" : task.assignments.filter(a => selected.includes(a.userId)).map(a => initials(a.name)).join(" ") || `${selected.length} assigned`}
            </button>
            <FloatingPopover open={open} anchorRef={triggerRef} onClose={() => setOpen(false)} width={320}>
                <CrewChecklist legend={legend} options={options} selected={selected} onToggle={toggle} />
            </FloatingPopover>
        </>
    );
}
