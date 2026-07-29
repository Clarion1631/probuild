"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { setPortalStageOverride } from "@/lib/actions";

const AUTO_VALUE = "__auto__";

export default function PortalStagePin({
    projectId,
    stageLabels,
    currentOverride,
}: {
    projectId: string;
    stageLabels: string[];
    currentOverride: string | null;
}) {
    const router = useRouter();
    const [value, setValue] = useState(currentOverride ?? AUTO_VALUE);
    const [isPending, startTransition] = useTransition();

    const handleChange = (next: string) => {
        const previous = value;
        setValue(next);
        startTransition(async () => {
            try {
                await setPortalStageOverride(projectId, next === AUTO_VALUE ? null : next);
                toast.success(
                    next === AUTO_VALUE
                        ? "Stage back to automatic (from schedule)"
                        : `Route pinned at ${next}`,
                );
                router.refresh();
            } catch (error) {
                setValue(previous);
                toast.error(error instanceof Error ? error.message : "Could not update the stage");
            }
        });
    };

    return (
        <label className="ml-auto flex shrink-0 items-center gap-2 text-xs font-medium text-amber-800">
            Route stage
            <select
                value={value}
                onChange={event => handleChange(event.target.value)}
                disabled={isPending}
                className="rounded-md border border-amber-300 bg-white px-2 py-1 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:opacity-60"
            >
                <option value={AUTO_VALUE}>Auto (from schedule)</option>
                {stageLabels.map(label => (
                    <option key={label} value={label}>{label}</option>
                ))}
            </select>
        </label>
    );
}
