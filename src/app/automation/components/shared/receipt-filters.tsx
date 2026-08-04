"use client";

import type { SerializedJourney } from "../journey-list";
import { isStaleBookedApi } from "./stale-detection";

export type FilterKey = "all" | "booked" | "needs-attention" | "in-flight";

export const FILTERS: { key: FilterKey; label: string; test: (j: SerializedJourney, now: number) => boolean }[] = [
    { key: "all", label: "All", test: () => true },
    { key: "booked", label: "Booked", test: (j) => j.finalState === "booked-api" || j.finalState === "booked-email" },
    {
        key: "needs-attention",
        label: "Needs attention",
        test: (j, now) => j.finalState === "parked" || j.finalState === "quarantined" || j.finalState === "error" || isStaleBookedApi(j, now),
    },
    { key: "in-flight", label: "In flight", test: (j) => j.finalState === "in-flight" },
];

/** The row of pill buttons ("All (12)", "Booked (8)", …) that filters the
 * receipt journey list. */
export function ReceiptFilterBar({
    journeys,
    filter,
    onFilterChange,
    now,
}: {
    journeys: SerializedJourney[];
    filter: FilterKey;
    onFilterChange: (key: FilterKey) => void;
    now: number;
}) {
    return (
        <div className="flex flex-wrap gap-2">
            {FILTERS.map((f) => {
                const count = journeys.filter((j) => f.test(j, now)).length;
                const active = filter === f.key;
                return (
                    <button
                        key={f.key}
                        type="button"
                        onClick={() => onFilterChange(f.key)}
                        className={`text-xs font-semibold px-3 py-1 rounded-full transition-colors ${
                            active ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                        }`}
                    >
                        {f.label} ({count})
                    </button>
                );
            })}
        </div>
    );
}
