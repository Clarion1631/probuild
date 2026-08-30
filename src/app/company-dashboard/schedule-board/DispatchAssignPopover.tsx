"use client";

import type { RefObject } from "react";
import { FloatingPopover, type FloatingPopoverAnchorPoint } from "./FloatingPopover";

export interface DispatchAssignChoice {
    id: string;
    // Already disambiguated ("Justin Adkins (jadkins@…)") when this name
    // collides with another crew member's — see disambiguateMemberNames in
    // dispatch-day-rows.ts.
    name: string;
    email: string;
    /** "Also on <job> today" when picking them would double-book them, else null. */
    conflictTitle: string | null;
}

interface DispatchAssignPopoverProps {
    open: boolean;
    taskName: string;
    choices: DispatchAssignChoice[];
    anchorRef: RefObject<HTMLElement | null>;
    anchorPoint?: FloatingPopoverAnchorPoint | null;
    onAssign: (userId: string) => void;
    onClose: () => void;
}

/**
 * Day mode's "+ Assign" popover — picks a crew member for one task. The
 * inverse of DispatchCrewTaskChooser (which picks a task for a crew member
 * already grabbed via drag); built as its own minimal component on the same
 * FloatingPopover primitive so the two flows don't fight over what "choices"
 * means, but writes through the identical onDraftCrewAdd draft/publish path.
 */
export function DispatchAssignPopover({
    open,
    taskName,
    choices,
    anchorRef,
    anchorPoint,
    onAssign,
    onClose,
}: DispatchAssignPopoverProps) {
    return (
        <FloatingPopover open={open} anchorRef={anchorRef} anchorPoint={anchorPoint} onClose={onClose} width={260} titleId="dispatch-assign-popover-title">
            <div>
                <p id="dispatch-assign-popover-title" className="text-xs font-semibold text-hui-textMain">Assign to {taskName}</p>
                <div className="mt-2 max-h-64 space-y-0.5 overflow-y-auto">
                    {choices.length === 0 ? (
                        <p className="rounded border border-dashed border-hui-border px-3 py-4 text-center text-xs text-hui-textMuted">
                            Everyone on the crew is already on this task.
                        </p>
                    ) : choices.map(choice => (
                        <button
                            key={choice.id}
                            type="button"
                            onClick={() => { onAssign(choice.id); onClose(); }}
                            title={choice.email}
                            className="block w-full rounded-md px-2.5 py-1.5 text-left transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hui-primary"
                        >
                            <span className="block text-xs font-semibold text-hui-textMain">{choice.name}</span>
                            {choice.conflictTitle && (
                                <span className="mt-0.5 block text-[10px] font-medium text-red-600">{choice.conflictTitle}</span>
                            )}
                        </button>
                    ))}
                </div>
            </div>
        </FloatingPopover>
    );
}
