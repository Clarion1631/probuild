"use client";

import { useState, useEffect } from "react";
import ProjectMessagingPanel from "@/components/ProjectMessagingPanel";

interface EstimateOption {
    id: string;
    code: string;
    title: string;
    status: string;
}

interface ProjectMessagingToggleProps {
    projectId: string;
    clientName: string;
    clientEmail?: string | null;
    clientPhone?: string | null;
    estimates: EstimateOption[];
    currentUserName?: string;
    currentUserEmail?: string;
    unreadCount?: number;
}

export default function ProjectMessagingToggle({
    projectId, clientName, clientEmail, clientPhone, estimates,
    currentUserName, currentUserEmail, unreadCount = 0,
}: ProjectMessagingToggleProps) {
    // undefined = pre-mount (renders collapsed strip to avoid CLS flash)
    const [open, setOpen] = useState<boolean | undefined>(undefined);

    useEffect(() => {
        try {
            const stored = localStorage.getItem("projectMessagingOpen");
            setOpen(stored === "false" ? false : true);
        } catch {
            setOpen(true);
        }
    }, []);

    const toggle = () => {
        setOpen(prev => {
            const next = !prev;
            try {
                localStorage.setItem("projectMessagingOpen", String(next));
            } catch {
                // Private browsing — continue with in-memory state
            }
            return next;
        });
    };

    // Collapsed or pre-mount: narrow icon strip
    if (open === false || open === undefined) {
        return (
            <div className="w-10 shrink-0 border-l border-slate-200 bg-white flex flex-col items-center pt-4 h-full">
                <button
                    onClick={open === undefined ? undefined : toggle}
                    aria-label="Expand messages"
                    title="Expand messages"
                    className="relative p-2 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-hui-primary transition"
                >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/>
                    </svg>
                    {unreadCount > 0 && (
                        <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] flex items-center justify-center text-[9px] font-bold bg-red-500 text-white rounded-full px-0.5">
                            {unreadCount > 99 ? "99+" : unreadCount}
                        </span>
                    )}
                </button>
            </div>
        );
    }

    // Open: zero-width left-edge toggle tab + 380px panel
    return (
        <>
            {/* Left-edge toggle tab — zero-width so it sits exactly on the panel's left border */}
            <div className="relative shrink-0 self-stretch" style={{ width: 0, zIndex: 10 }}>
                <button
                    onClick={toggle}
                    aria-label="Collapse messages"
                    title="Collapse messages"
                    style={{
                        position: "absolute",
                        left: 0,
                        top: "50%",
                        transform: "translateY(-50%)",
                    }}
                    className="w-5 h-10 bg-white border border-hui-border border-r-0 rounded-l-md shadow-sm flex items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-50 transition"
                >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 18l-6-6 6-6"/>
                    </svg>
                </button>
            </div>

            {/* Panel */}
            <div className="w-[380px] shrink-0 h-full">
                <ProjectMessagingPanel
                    projectId={projectId}
                    clientName={clientName}
                    clientEmail={clientEmail}
                    clientPhone={clientPhone}
                    estimates={estimates}
                />
            </div>
        </>
    );
}
