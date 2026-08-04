import type { SerializedJourney } from "../journey-list";

export const FINAL_STATE_STYLE: Record<
    SerializedJourney["finalState"],
    { icon: string; label: string; bg: string; text: string; pulse?: boolean }
> = {
    "booked-api": { icon: "✓", label: "Booked", bg: "bg-teal-100", text: "text-teal-700" },
    "booked-email": { icon: "✉", label: "Booked via email", bg: "bg-amber-100", text: "text-amber-700" },
    parked: { icon: "⏸", label: "Needs review", bg: "bg-amber-100", text: "text-amber-700" },
    quarantined: { icon: "⧉", label: "Duplicate", bg: "bg-slate-100", text: "text-slate-600" },
    error: { icon: "✗", label: "Error", bg: "bg-red-100", text: "text-red-700" },
    "in-flight": { icon: "●", label: "In flight", bg: "bg-blue-100", text: "text-blue-700", pulse: true },
};

export function StateChip({ state }: { state: SerializedJourney["finalState"] }) {
    const style = FINAL_STATE_STYLE[state];
    return (
        <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${style.bg} ${style.text}`}>
            <span className={style.pulse ? "animate-pulse" : ""}>{style.icon}</span>
            {style.label}
        </span>
    );
}
