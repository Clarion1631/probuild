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

/**
 * A4: `unconfirmed` is REQUIRED, not optional — an omitted prop must never
 * silently default to "confirmed" and render green. True whenever the
 * receipt identity behind `state` is itself a guess (a bare docNumber-prefix
 * match, or a journey only ever grouped by that prefix): downgrades the chip
 * to the same neutral "?" styling regardless of what `state` says, so a
 * guessed match can never carry the same visual weight as a confirmed one.
 */
export function StateChip({ state, unconfirmed }: { state: SerializedJourney["finalState"]; unconfirmed: boolean }) {
    const style = FINAL_STATE_STYLE[state];
    const bg = unconfirmed ? "bg-slate-100" : style.bg;
    const text = unconfirmed ? "text-slate-500" : style.text;
    const icon = unconfirmed ? "?" : style.icon;
    return (
        <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${bg} ${text}`}>
            <span className={!unconfirmed && style.pulse ? "animate-pulse" : ""}>{icon}</span>
            {style.label}
        </span>
    );
}
