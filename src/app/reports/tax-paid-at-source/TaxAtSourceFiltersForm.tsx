"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatLocalDateString, type TaxAtSourceFilters } from "@/lib/tax-at-source-report";

/** The `to` the server holds is EXCLUSIVE; the picker shows the inclusive day. */
function inclusiveTo(filters: TaxAtSourceFilters): string {
    const day = new Date(filters.to.getTime());
    day.setDate(day.getDate() - 1);
    return formatLocalDateString(day);
}

export default function TaxAtSourceFiltersForm({ filters }: { filters: TaxAtSourceFilters }) {
    const router = useRouter();
    const [from, setFrom] = useState<string>(formatLocalDateString(filters.from));
    const [to, setTo] = useState<string>(inclusiveTo(filters));

    function apply(next?: { from: string; to: string }) {
        const params = new URLSearchParams({
            from: next?.from ?? from,
            to: next?.to ?? to,
        });
        router.push(`/reports/tax-paid-at-source?${params.toString()}`);
    }

    function applyQuarter(offset: number) {
        const now = new Date();
        const start = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3 + offset * 3, 1);
        const end = new Date(start.getFullYear(), start.getMonth() + 3, 0);
        const nextFrom = formatLocalDateString(start);
        const nextTo = formatLocalDateString(end);
        setFrom(nextFrom);
        setTo(nextTo);
        apply({ from: nextFrom, to: nextTo });
    }

    return (
        <div className="hui-card p-4 flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1">
                <span className="text-xs text-hui-textMuted font-medium uppercase tracking-wider">From</span>
                <input
                    type="date"
                    className="hui-input"
                    value={from}
                    onChange={event => setFrom(event.target.value)}
                />
            </label>
            <label className="flex flex-col gap-1">
                <span className="text-xs text-hui-textMuted font-medium uppercase tracking-wider">To</span>
                <input
                    type="date"
                    className="hui-input"
                    value={to}
                    onChange={event => setTo(event.target.value)}
                />
            </label>
            <button type="button" className="hui-btn hui-btn-primary text-sm" onClick={() => apply()}>
                Apply
            </button>
            <div className="flex items-center gap-2 ml-auto">
                <button type="button" className="hui-btn hui-btn-secondary text-sm" onClick={() => applyQuarter(0)}>
                    This quarter
                </button>
                <button type="button" className="hui-btn hui-btn-secondary text-sm" onClick={() => applyQuarter(-1)}>
                    Last quarter
                </button>
            </div>
        </div>
    );
}
