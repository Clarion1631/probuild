"use client";

import { useState } from "react";
import ClientMessaging from "@/components/ClientMessaging";

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
}

export default function ProjectMessagingPanel({
    projectId, clientName, clientEmail, clientPhone, estimates,
}: ProjectMessagingPanelProps) {
    const [activeTab, setActiveTab] = useState<"client" | "internal">("client");

    return (
        <div className="h-full flex flex-col border-l border-slate-200 bg-white">
            {/* Tab header */}
            <div className="flex items-center px-4 py-3 border-b border-slate-200 bg-white shrink-0">
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
                        onClick={() => setActiveTab("internal")}
                        className={`px-3 py-1.5 text-sm font-medium rounded-md transition ${
                            activeTab === "internal"
                                ? "bg-white text-slate-800 shadow-sm"
                                : "text-slate-500 hover:text-slate-700"
                        }`}
                    >
                        Team Notes
                    </button>
                </div>
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
                    <div className="flex flex-col items-center justify-center h-full px-6 text-center gap-3">
                        <div className="w-12 h-12 bg-slate-100 rounded-xl flex items-center justify-center">
                            <svg className="w-6 h-6 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 8h2a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2v-8a2 2 0 012-2h2m5-4v12m0-12l-3 3m3-3l3 3"/>
                            </svg>
                        </div>
                        <div>
                            <p className="text-sm font-medium text-slate-700">Team Notes</p>
                            <p className="text-xs text-slate-400 mt-1">Internal notes visible only to your team — coming soon.</p>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
