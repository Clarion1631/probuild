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
        "group relative flex w-full flex-col items-center justify-center gap-1.5 px-1 py-3 text-[10px] tracking-wide transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#531b7e]";
    
    return (
        <button
            type="button"
            aria-pressed={active}
            className={`${base} bg-transparent ${className}`}
            {...rest}
        >
            <span 
                className={`flex h-11 w-11 items-center justify-center rounded-full transition-all duration-200 [&_svg]:h-5 [&_svg]:w-5 ${
                    active 
                        ? "bg-[#531b7e] text-white shadow-sm" 
                        : "text-slate-400 bg-transparent group-hover:bg-slate-100 group-hover:text-slate-700"
                }`}
            >
                {icon}
            </span>
            <span 
                className={`leading-tight text-center px-1 font-semibold transition-colors duration-200 ${
                    active 
                        ? "text-[#2e103f] font-bold" 
                        : "text-slate-500 group-hover:text-slate-800"
                }`}
            >
                {label}
            </span>
        </button>
    );
}
