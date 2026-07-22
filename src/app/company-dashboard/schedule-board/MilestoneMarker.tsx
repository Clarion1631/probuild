import { addDays, formatCurrency, getDaysBetween, parseUTCDate } from "@/app/projects/[id]/schedule/schedule-utils";
import { toTimelineRect, type DateRange } from "./useBarLayout";

interface MilestoneMarkerProps {
    name: string;
    amount: number;
    effectiveDueDate: string;
    visibleRange: DateRange;
    kind: "income" | "change-order";
    offsetPixels?: number;
    timelineOrigin?: Date;
    dayWidth?: number;
}

export function MilestoneMarker({ name, amount, effectiveDueDate, visibleRange, kind, offsetPixels = 0, timelineOrigin, dayWidth }: MilestoneMarkerProps) {
    const date = parseUTCDate(effectiveDueDate.slice(0, 10));
    if (date < visibleRange.start || date >= visibleRange.end) return null;

    const visibleDays = getDaysBetween(visibleRange.start, visibleRange.end);
    const left = (getDaysBetween(visibleRange.start, date) + 0.5) / visibleDays * 100;
    const timelineLeft = timelineOrigin && dayWidth
        ? toTimelineRect({ start: date, end: addDays(date, 1) }, timelineOrigin, dayWidth).left + dayWidth / 2
        : null;
    const typeLabel = kind === "income" ? "Income" : "Projected change order";
    const title = `${typeLabel}: ${name} — ${formatCurrency(amount)} — UTC ${effectiveDueDate.slice(0, 10)}`;

    return (
        <span
            className={`absolute top-[17px] z-30 h-2.5 w-2.5 -translate-x-1/2 rotate-45 border border-white shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 ${kind === "income" ? "bg-emerald-500" : "bg-amber-400"}`}
            style={{ left: timelineLeft ?? `${left}%`, marginLeft: offsetPixels }}
            title={title}
            aria-label={title}
            tabIndex={0}
        />
    );
}
