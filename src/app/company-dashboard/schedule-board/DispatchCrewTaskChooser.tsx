"use client";

import type { RefObject } from "react";
import { FloatingPopover } from "./FloatingPopover";
import type { FloatingPopoverAnchorPoint } from "./FloatingPopover";

export interface DispatchCrewTaskChoice {
    projectId: string;
    projectName: string;
    taskId: string;
    taskName: string;
    dayLabel?: string;
}

interface DispatchCrewTaskChooserProps {
    open: boolean;
    crewName: string;
    choices: DispatchCrewTaskChoice[];
    anchorPoint: FloatingPopoverAnchorPoint | null;
    anchorRef: RefObject<HTMLElement | null>;
    onChoose: (taskId: string) => void;
    onClose: () => void;
}

export function DispatchCrewTaskChooser({
    open,
    crewName,
    choices,
    anchorPoint,
    anchorRef,
    onChoose,
    onClose,
}: DispatchCrewTaskChooserProps) {
    return (
        <FloatingPopover
            open={open}
            anchorPoint={anchorPoint}
            anchorRef={anchorRef}
            onClose={onClose}
            width={300}
        >
            <div>
                <p className="text-xs font-semibold text-hui-textMain">Assign {crewName}</p>
                <p className="mt-0.5 text-[11px] text-hui-textMuted">Choose a task for this crew draft.</p>
                <div className="mt-3 space-y-1">
                    {choices.length === 0 ? (
                        <p className="rounded border border-dashed border-hui-border px-3 py-4 text-center text-xs text-hui-textMuted">
                            No active tasks are available.
                        </p>
                    ) : choices.map(choice => (
                        <button
                            key={`${choice.taskId}-${choice.dayLabel ?? ""}`}
                            type="button"
                            onClick={() => onChoose(choice.taskId)}
                            className="block w-full rounded-md px-2.5 py-2 text-left transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hui-primary"
                        >
                            <span className="block text-xs font-semibold text-hui-textMain">{choice.taskName}</span>
                            <span className="mt-0.5 block text-[10px] text-hui-textMuted">
                                {choice.projectName}{choice.dayLabel ? ` · ${choice.dayLabel}` : ""}
                            </span>
                        </button>
                    ))}
                </div>
            </div>
        </FloatingPopover>
    );
}
