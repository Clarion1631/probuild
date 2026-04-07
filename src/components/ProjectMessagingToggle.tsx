"use client";

import { useState } from "react";
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
    const [open, setOpen] = useState(false);

    return (
        <>
            {/* Floating chat button */}
            <button
                onClick={() => setOpen(v => !v)}
                title="Messages"
                className="fixed bottom-6 right-6 z-30 w-12 h-12 rounded-full bg-hui-primary text-white shadow-lg hover:shadow-xl hover:scale-105 transition-all flex items-center justify-center"
            >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/>
                </svg>
                {unreadCount > 0 && (
                    <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] flex items-center justify-center text-[10px] font-bold bg-red-500 text-white rounded-full px-1">
                        {unreadCount > 99 ? "99+" : unreadCount}
                    </span>
                )}
            </button>

            {open && (
                <ProjectMessagingPanel
                    projectId={projectId}
                    clientName={clientName}
                    clientEmail={clientEmail}
                    clientPhone={clientPhone}
                    estimates={estimates}
                    currentUserName={currentUserName}
                    currentUserEmail={currentUserEmail}
                    onClose={() => setOpen(false)}
                />
            )}
        </>
    );
}
