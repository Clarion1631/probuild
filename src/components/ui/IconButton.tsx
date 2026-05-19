// Square icon-only button. Tooltip via title, optional pressed state for
// toggleable controls (e.g. Layers / Properties). Honors hover-none devices
// per CLAUDE.md mandate — pressed-state styling is independent of :hover.

import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type Size = "sm" | "md";

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    icon: ReactNode;
    label: string;
    size?: Size;
    pressed?: boolean;
}

const SIZE_CLASSES: Record<Size, string> = {
    sm: "h-7 w-7 [&_svg]:h-3.5 [&_svg]:w-3.5",
    md: "h-9 w-9 [&_svg]:h-4 [&_svg]:w-4",
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
    { icon, label, size = "md", pressed = false, className = "", ...rest },
    ref,
) {
    const base =
        "inline-flex items-center justify-center rounded-md border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#531b7e] focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-40";
    const state = pressed
        ? "border-[#531b7e]/30 bg-purple-50 text-[#531b7e]"
        : "border-transparent bg-transparent text-slate-600 hover:bg-slate-100 hover:text-slate-900";
    return (
        <button
            ref={ref}
            type="button"
            title={label}
            aria-label={label}
            aria-pressed={pressed}
            className={`${base} ${SIZE_CLASSES[size]} ${state} ${className}`}
            {...rest}
        >
            {icon}
        </button>
    );
});
