// Bottom-centered floating bar shell over the 3D canvas. Outer wrapper is
// `pointer-events-none` so it doesn't intercept canvas drags; inner pill is
// `pointer-events-auto` so its own controls work. Mirrors the positioning
// pattern from UnifiedCadToolbar so the two can stack.

import type { ReactNode } from "react";

interface FloatingDockProps {
    children: ReactNode;
    className?: string;
    /** Tailwind bottom-* class. Defaults to `bottom-4`. Pass `bottom-20` to
     * stack above another dock at the default position. */
    bottom?: string;
}

export function FloatingDock({ children, className = "", bottom = "bottom-4" }: FloatingDockProps) {
    return (
        <div
            className={`pointer-events-none absolute ${bottom} left-1/2 z-10 flex w-full max-w-[800px] -translate-x-1/2 items-center justify-center`}
        >
            <div
                className={`pointer-events-auto flex items-center gap-3 rounded-full border border-slate-200 bg-white/95 px-5 py-1.5 shadow-lg backdrop-blur-md transition-shadow duration-300 ${className}`}
            >
                {children}
            </div>
        </div>
    );
}

export function FloatingDockDivider() {
    return <div className="h-5 w-px bg-slate-200" aria-hidden />;
}
