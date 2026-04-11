"use client";

import React from "react";

export type BulkAction = {
    label: string;
    icon?: React.ReactNode;
    onClick: () => void;
    variant?: "danger" | "default";
    disabled?: boolean;
};

type Props = {
    count: number;
    actions: BulkAction[];
    onClear?: () => void;
};

export default function BulkActionBar({ count, actions, onClear }: Props) {
    if (count === 0) return null;

    const hasDanger = actions.some(a => a.variant === "danger");

    // Outer pill style: red if any danger action, slate otherwise
    const pillClass = hasDanger
        ? "bg-red-50 text-red-700 border-red-200"
        : "bg-slate-50 text-slate-700 border-slate-200";

    const separatorClass = hasDanger ? "bg-red-200" : "bg-slate-200";

    return (
        <div
            className={`flex items-center gap-3 px-4 py-2 rounded-lg border animate-in fade-in slide-in-from-bottom-2 ${pillClass}`}
        >
            <span className="text-sm font-semibold">{count} selected</span>
            {actions.map((action, i) => (
                <React.Fragment key={i}>
                    <div className={`h-4 w-px ${separatorClass}`}></div>
                    <button
                        onClick={action.onClick}
                        disabled={action.disabled}
                        className={`text-sm font-semibold flex items-center gap-1.5 disabled:opacity-50 ${
                            action.variant === "danger"
                                ? "hover:text-red-800"
                                : "hover:text-slate-900"
                        }`}
                    >
                        {action.icon}
                        {action.label}
                    </button>
                </React.Fragment>
            ))}
            {onClear && (
                <>
                    <div className={`h-4 w-px ${separatorClass}`}></div>
                    <button
                        onClick={onClear}
                        className="text-sm opacity-60 hover:opacity-100"
                        aria-label="Clear selection"
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M18 6L6 18M6 6l12 12" />
                        </svg>
                    </button>
                </>
            )}
        </div>
    );
}

export const DeleteIcon = (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
    </svg>
);

export const CopyIcon = (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
        <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
    </svg>
);

export const MoveIcon = (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M5 12h14M12 5l7 7-7 7" />
    </svg>
);
