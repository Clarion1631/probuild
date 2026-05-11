"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getUnreadFieldUpdatesCount } from "@/lib/actions";

// Sidebar item with unread badge. Refetches on mount + every 60s so the manager sees
// new field activity without manual refresh. Not realtime; cheap enough as a poll.
export default function FieldUpdatesNavItem() {
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

    return (
        <Link
            href="/manager/field-updates"
            className="relative flex flex-col items-center justify-center w-full py-3 hover:bg-[#2a2a2a] text-slate-400 hover:text-white transition group"
        >
            <svg className="w-5 h-5 mb-1 group-hover:text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
            <span className="text-[10px] uppercase font-semibold text-center leading-tight">Field</span>
            {count !== null && count > 0 && (
                <span className="absolute top-1.5 right-2.5 min-w-[18px] h-[18px] bg-hui-primary text-white text-[10px] font-bold rounded-full flex items-center justify-center px-1">
                    {count > 99 ? "99+" : count}
                </span>
            )}
        </Link>
    );
}
