// Lightweight breadcrumb with a back chevron and clickable crumb segments.
// Generic enough for any internal tool (room designer first consumer).

import { ChevronLeft, ChevronRight } from "lucide-react";

export interface BreadcrumbItem {
    label: string;
    onClick?: () => void;
}

interface BreadcrumbProps {
    items: BreadcrumbItem[];
    onBack?: () => void;
    className?: string;
}

export function Breadcrumb({ items, onBack, className = "" }: BreadcrumbProps) {
    return (
        <nav
            aria-label="Breadcrumb"
            className={`flex items-center gap-1 text-xs text-slate-500 ${className}`}
        >
            {onBack && (
                <button
                    type="button"
                    onClick={onBack}
                    aria-label="Back"
                    className="-ml-1 mr-1 inline-flex h-6 w-6 items-center justify-center rounded text-slate-500 hover:bg-slate-100 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#531b7e]"
                >
                    <ChevronLeft className="h-4 w-4" />
                </button>
            )}
            {items.map((item, i) => {
                const isLast = i === items.length - 1;
                const clickable = item.onClick && !isLast;
                return (
                    <span key={`${item.label}-${i}`} className="flex items-center gap-1">
                        {clickable ? (
                            <button
                                type="button"
                                onClick={item.onClick}
                                className="rounded px-1 py-0.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#531b7e]"
                            >
                                {item.label}
                            </button>
                        ) : (
                            <span
                                aria-current={isLast ? "page" : undefined}
                                className={`px-1 py-0.5 ${isLast ? "font-semibold text-slate-900" : "text-slate-500"}`}
                            >
                                {item.label}
                            </span>
                        )}
                        {!isLast && <ChevronRight className="h-3 w-3 text-slate-300" aria-hidden />}
                    </span>
                );
            })}
        </nav>
    );
}
