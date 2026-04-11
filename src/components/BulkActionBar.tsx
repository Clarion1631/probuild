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

    return (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 animate-in fade-in slide-in-from-bottom-3 duration-200">
            <div className="flex items-center gap-1 bg-slate-900 text-white rounded-xl shadow-2xl border border-slate-700 px-3 py-2">
                {/* Count badge */}
                <span className="text-xs font-semibold bg-slate-700 rounded-md px-2 py-1 mr-1 tabular-nums">
                    {count} selected
                </span>

                <div className="h-4 w-px bg-slate-700 mx-1" />

                {actions.map((action, i) => (
                    <React.Fragment key={i}>
                        {i > 0 && <div className="h-4 w-px bg-slate-700 mx-0.5" />}
                        <button
                            onClick={action.onClick}
                            disabled={action.disabled}
                            className={`flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg transition disabled:opacity-40 ${
                                action.variant === "danger"
                                    ? "hover:bg-red-600 hover:text-white text-red-400"
                                    : "hover:bg-slate-700 text-slate-200"
                            }`}
                        >
                            {action.icon}
                            {action.label}
                        </button>
                    </React.Fragment>
                ))}

                {onClear && (
                    <>
                        <div className="h-4 w-px bg-slate-700 mx-1" />
                        <button
                            onClick={onClear}
                            className="p-1.5 rounded-lg hover:bg-slate-700 text-slate-400 hover:text-white transition"
                            aria-label="Clear selection"
                        >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                <path d="M18 6L6 18M6 6l12 12" />
                            </svg>
                        </button>
                    </>
                )}
            </div>
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
