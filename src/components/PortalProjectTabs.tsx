"use client";

import Link from "next/link";
import { useRef, KeyboardEvent } from "react";

export interface PortalTab {
    id: string;
    label: string;
    count?: number;
    href: string;
}

interface Props {
    tabs: PortalTab[];
    activeTab: string;
}

export default function PortalProjectTabs({ tabs, activeTab }: Props) {
    const listRef = useRef<HTMLDivElement>(null);

    const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        const buttons = listRef.current?.querySelectorAll<HTMLAnchorElement>('[role="tab"]');
        if (!buttons || buttons.length === 0) return;

        const currentIndex = Array.from(buttons).findIndex(b => b === document.activeElement);
        if (currentIndex === -1) return;

        // Space activates the focused tab (Enter is handled natively by the link).
        if (e.key === " " || e.key === "Spacebar") {
            e.preventDefault();
            buttons[currentIndex].click();
            return;
        }

        let nextIndex = currentIndex;
        switch (e.key) {
            case "ArrowRight":
                nextIndex = (currentIndex + 1) % buttons.length;
                break;
            case "ArrowLeft":
                nextIndex = (currentIndex - 1 + buttons.length) % buttons.length;
                break;
            case "Home":
                nextIndex = 0;
                break;
            case "End":
                nextIndex = buttons.length - 1;
                break;
            default:
                return;
        }
        e.preventDefault();
        buttons[nextIndex].focus();
    };

    return (
        <div className="sticky top-0 z-30 -mx-4 md:-mx-8 px-4 md:px-8 bg-white/95 backdrop-blur border-b border-hui-border mb-6">
            <div
                ref={listRef}
                role="tablist"
                aria-label="Project sections"
                onKeyDown={handleKeyDown}
                className="flex gap-1 overflow-x-auto snap-x [&::-webkit-scrollbar]:hidden"
                style={{ scrollbarWidth: "none" }}
            >
                {tabs.map(tab => {
                    const isActive = tab.id === activeTab;
                    return (
                        <Link
                            key={tab.id}
                            id={`tab-${tab.id}`}
                            href={tab.href}
                            scroll={false}
                            replace
                            role="tab"
                            aria-selected={isActive}
                            aria-controls={`panel-${tab.id}`}
                            tabIndex={isActive ? 0 : -1}
                            className={`
                                shrink-0 snap-start
                                inline-flex items-center gap-2
                                px-4 py-3 text-sm font-medium
                                border-b-2 transition
                                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hui-primary focus-visible:ring-offset-1
                                ${isActive
                                    ? "border-hui-primary text-hui-primary font-semibold"
                                    : "border-transparent text-hui-textMuted hover:text-hui-textMain hover:border-slate-300"
                                }
                            `}
                        >
                            <span>{tab.label}</span>
                            {typeof tab.count === "number" && tab.count > 0 && (
                                <span className={`
                                    text-xs px-1.5 py-0.5 rounded-full font-semibold
                                    ${isActive
                                        ? "bg-green-100 text-green-700"
                                        : "bg-slate-100 text-slate-600"
                                    }
                                `}>
                                    {tab.count}
                                </span>
                            )}
                        </Link>
                    );
                })}
            </div>
        </div>
    );
}
