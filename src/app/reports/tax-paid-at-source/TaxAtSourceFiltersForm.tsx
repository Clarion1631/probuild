"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Dates in, dates out — both as company-calendar "YYYY-MM-DD" keys the server
 * computed. The browser deliberately does NO date math: a crew laptop set to
 * Mountain Time must not shift a quarter boundary, and `new Date()` here would
 * do exactly that. The quarter presets are the server's own values, passed in.
 */
export interface QuarterPreset {
    label: string;
    fromKey: string;
    toKey: string;
}

export default function TaxAtSourceFiltersForm({
    fromKey,
    toKey,
    presets,
}: {
    fromKey: string;
    toKey: string;
    presets: QuarterPreset[];
}) {
    const router = useRouter();
    const [from, setFrom] = useState<string>(fromKey);
    const [to, setTo] = useState<string>(toKey);

    function apply(next?: { from: string; to: string }) {
        const params = new URLSearchParams({
            from: next?.from ?? from,
            to: next?.to ?? to,
        });
        router.push(`/reports/tax-paid-at-source?${params.toString()}`);
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
                {presets.map(preset => (
                    <button
                        key={preset.label}
                        type="button"
                        className="hui-btn hui-btn-secondary text-sm"
                        onClick={() => {
                            setFrom(preset.fromKey);
                            setTo(preset.toKey);
                            apply({ from: preset.fromKey, to: preset.toKey });
                        }}
                    >
                        {preset.label}
                    </button>
                ))}
            </div>
        </div>
    );
}
