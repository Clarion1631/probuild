"use client";

import { useState } from "react";
import ClientMessaging from "@/components/ClientMessaging";
import ProjectChat from "@/components/ProjectChat";

interface EstimateOption {
    id: string;
    code: string;
    title: string;
    status: string;
}

interface ProjectMessagingPanelProps {
    projectId: string;
    clientName: string;
    clientEmail?: string | null;
    clientPhone?: string | null;
    estimates: EstimateOption[];
    currentUserName?: string;
    currentUserEmail?: string;
    onClose: () => void;
}

export default function ProjectMessagingPanel({
    projectId, clientName, clientEmail, clientPhone, estimates,
    currentUserName, currentUserEmail, onClose,
}: ProjectMessagingPanelProps) {
    const [activeTab, setActiveTab] = useState<"client" | "team">("client");

    return (
        <>
            {/* Backdrop */}
            <div
                className="fixed inset-0 z-40 bg-black/20"
                onClick={onClose}
            />

            {/* Panel */}
            <div className="fixed right-0 top-0 h-full w-[400px] z-50 bg-white shadow-2xl flex flex-col border-l border-slate-200 transition-transform duration-200">
                {/* Header */}
                <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 bg-white shrink-0">
                    <div className="flex items-center gap-1 bg-slate-100 rounded-lg p-1">
                        <button
                            onClick={() => setActiveTab("client")}
                            className={`px-3 py-1.5 text-sm font-medium rounded-md transition ${
                                activeTab === "client"
                                    ? "bg-white text-slate-800 shadow-sm"
                                    : "text-slate-500 hover:text-slate-700"
                            }`}
                        >
                            Client
                        </button>
                        <button
                            onClick={() => setActiveTab("team")}
                            className={`px-3 py-1.5 text-sm font-medium rounded-md transition ${
                                activeTab === "team"
                                    ? "bg-white text-slate-800 shadow-sm"
                                    : "text-slate-500 hover:text-slate-700"
                            }`}
                        >
                            Team
                        </button>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-1.5 rounded hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition"
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/>
                        </svg>
                    </button>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-hidden">
                    {activeTab === "client" ? (
                        <ClientMessaging
                            entityId={projectId}
                            entityType="project"
                            clientName={clientName}
                            clientEmail={clientEmail}
                            clientPhone={clientPhone}
                            estimates={estimates}
                            variant="sidebar"
                        />
                    ) : (
                        <ProjectChat
                            projectId={projectId}
                            perspective="TEAM"
                            currentUserName={currentUserName}
                            currentUserEmail={currentUserEmail}
                        />
                    )}
                </div>
            </div>
        </>
    );
}
