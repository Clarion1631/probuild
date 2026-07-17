"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getUnreadFieldUpdatesCount } from "@/lib/actions";

const FieldIcon = ({ className }: { className?: string }) => (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
    </svg>
);

// Sidebar item with unread badge. Refetches on mount + every 60s so the manager sees
// new field activity without manual refresh. Not realtime; cheap enough as a poll.
// `variant` lets it render as the desktop icon-rail item (default) or a horizontal
// row inside the mobile nav drawer; the badge/polling is shared either way.
export default function FieldUpdatesNavItem({ variant = "rail", onNavigate }: { variant?: "rail" | "drawer"; onNavigate?: () => void }) {
    const [count, setCount] = useState<number | null>(null);

    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            try {
                const n = await getUnreadFieldUpdatesCount();
                if (!cancelled) setCount(n);
            } catch {
                if (!cancelled) setCount(null);
            }
        };
        load();
        const id = setInterval(load, 60_000);
        return () => { cancelled = true; clearInterval(id); };
    }, []);

    const badge = count !== null && count > 0 ? (count > 99 ? "99+" : count) : null;

    if (variant === "drawer") {
        return (
            <Link
                href="/manager/field-updates"
                onClick={onNavigate}
                className="relative flex items-center gap-3 px-4 py-3 rounded-lg text-slate-300 hover:bg-[#2a2a2a] hover:text-white transition"
            >
                <FieldIcon className="w-5 h-5 shrink-0" />
                <span className="text-sm font-medium">Field Updates</span>
                {badge !== null && (
                    <span className="ml-auto min-w-[20px] h-5 bg-hui-primary text-white text-[11px] font-bold rounded-full flex items-center justify-center px-1.5">
                        {badge}
                    </span>
                )}
            </Link>
        );
    }

    return (
        <Link
            href="/manager/field-updates"
            className="relative flex flex-col items-center justify-center w-full py-3 hover:bg-[#2a2a2a] text-slate-400 hover:text-white transition group"
        >
            <FieldIcon className="w-5 h-5 mb-1 group-hover:text-white" />
            <span className="text-[10px] uppercase font-semibold text-center leading-tight">Field</span>
            {badge !== null && (
                <span className="absolute top-1.5 right-2.5 min-w-[18px] h-[18px] bg-hui-primary text-white text-[10px] font-bold rounded-full flex items-center justify-center px-1">
                    {badge}
                </span>
            )}
        </Link>
    );
}
