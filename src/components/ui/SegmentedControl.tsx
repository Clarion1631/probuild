"use client";

import type { ReactNode } from "react";

export interface SegmentedControlOption<T extends string> {
    value: T;
    label: ReactNode;
    /** Overrides the button's accessible name when `label` isn't plain text (e.g. an icon). */
    ariaLabel?: string;
}

interface SegmentedControlProps<T extends string> {
    options: SegmentedControlOption<T>[];
    value: T;
    onChange: (value: T) => void;
    ariaLabel: string;
    className?: string;
}

// Shared 32px-tall segmented control — same height, radius, and selected/unselected
// styling everywhere it's used (Month|Timeline|Dispatch, Today|Week, ...). Uses the
// same role="group" + aria-pressed pattern the board's toggles already relied on.
export function SegmentedControl<T extends string>({ options, value, onChange, ariaLabel, className }: SegmentedControlProps<T>) {
    return (
        <div role="group" aria-label={ariaLabel} className={`inline-flex h-8 items-center rounded-md border border-hui-border bg-white p-0.5 ${className ?? ""}`}>
            {options.map(option => (
                <button
                    key={option.value}
                    type="button"
                    onClick={() => onChange(option.value)}
                    aria-pressed={value === option.value}
                    aria-label={option.ariaLabel}
                    className={`flex h-full items-center rounded px-3 text-xs font-semibold capitalize transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hui-primary ${value === option.value ? "bg-hui-primary text-white" : "text-hui-textMuted hover:bg-slate-50"}`}
                >
                    {option.label}
                </button>
            ))}
        </div>
    );
}
