// Left-rail stage button — icon stacked above a short uppercase label.
// Active state is a soft purple wash with a left border accent. Touch-only
// devices show the active state without needing :hover (CLAUDE.md mandate).

import type { ButtonHTMLAttributes, ReactNode } from "react";

interface TabButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    icon: ReactNode;
    label: string;
    active?: boolean;
}

export function TabButton({ icon, label, active = false, className = "", ...rest }: TabButtonProps) {
    const base =
        "group relative flex w-full flex-col items-center justify-center gap-1 px-1 py-2.5 text-[10px] font-semibold uppercase tracking-wide transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#531b7e]";
    const state = active
        ? "bg-purple-50 text-[#531b7e]"
        : "text-slate-500 hover:bg-slate-50 hover:text-slate-900";
    return (
        <button
            type="button"
            aria-pressed={active}
            className={`${base} ${state} ${className}`}
            {...rest}
        >
            {active && (
                <span
                    aria-hidden
                    className="absolute inset-y-0 left-0 w-0.5 bg-[#531b7e]"
                />
            )}
            <span className="[&_svg]:h-5 [&_svg]:w-5">{icon}</span>
            <span className="leading-tight">{label}</span>
        </button>
    );
}
