"use client";

import { useEffect, useRef, useState } from "react";
import type { DashboardProjectRow } from "@/lib/schedule-core";
import { FloatingPopover } from "./FloatingPopover";
import { activateExclusiveMenu, deactivateExclusiveMenu } from "./menuCoordinator";

interface ProjectTaskOverflowProps {
    projectName: string;
    tasks: DashboardProjectRow["tasks"];
}

export function ProjectTaskOverflow({ projectName, tasks }: ProjectTaskOverflowProps) {
    const triggerRef = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(false);

    useEffect(() => {
        if (!open) return;
        const close = () => setOpen(false);
        activateExclusiveMenu(close);
        return () => deactivateExclusiveMenu(close);
    }, [open]);

    if (tasks.length === 0) return null;

    return (
        <>
            <button
                ref={triggerRef}
                type="button"
                onClick={event => {
                    event.stopPropagation();
                    setOpen(value => !value);
                }}
                aria-expanded={open}
                className="absolute bottom-0 right-0 z-20 rounded-tl bg-black/40 px-1 text-[8px] font-bold text-white hover:bg-black/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                aria-label={`${tasks.length} more overlapping task${tasks.length === 1 ? "" : "s"} on ${projectName}`}
            >
                +{tasks.length}
            </button>
            <FloatingPopover open={open} anchorRef={triggerRef} onClose={() => setOpen(false)} width={200}>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-hui-textMuted">Also running</p>
                <ul className="space-y-1">
                    {tasks.map(task => (
                        <li key={task.id} className="truncate text-xs text-hui-textMain" title={task.name}>{task.name}</li>
                    ))}
                </ul>
            </FloatingPopover>
        </>
    );
}
