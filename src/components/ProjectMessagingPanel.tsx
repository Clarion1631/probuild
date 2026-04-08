"use client";

import { useState, useCallback } from "react";
import ClientMessaging from "@/components/ClientMessaging";
import TeamChat from "@/components/TeamChat";
import ActivityFeed from "@/components/ActivityFeed";

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
}

export default function ProjectMessagingPanel({
    projectId, clientName, clientEmail, clientPhone, estimates,
    currentUserName, currentUserEmail,
}: ProjectMessagingPanelProps) {
    const [activeTab, setActiveTab] = useState<"client" | "team" | "activity">("client");
    const [teamUnread, setTeamUnread] = useState(0);

    const handleTeamNewMessages = useCallback((count: number) => {
        if (count === 0) {
            setTeamUnread(0);
        } else {
            setTeamUnread((prev) => prev + count);
        }
    }, []);

    const tabs = [
        { key: "client" as const, label: "Client", badge: false },
        { key: "team" as const, label: "Team", badge: teamUnread > 0 },
        { key: "activity" as const, label: "Activity", badge: false },
    ];

    return (
        <div className="h-full flex flex-col border-l border-slate-200 bg-white">
            {/* Tab header */}
            <div className="flex items-center px-4 py-3 border-b border-slate-200 bg-white shrink-0">
                <div className="flex items-center gap-1 bg-slate-100 rounded-lg p-1 w-full">
                    {tabs.map((tab) => (
                        <button
                            key={tab.key}
                            onClick={() => setActiveTab(tab.key)}
                            className={`flex-1 relative px-2 py-1.5 text-sm font-medium rounded-md transition ${
                                activeTab === tab.key
                                    ? "bg-white text-slate-800 shadow-sm"
                                    : "text-slate-500 hover:text-slate-700"
                            }`}
                        >
                            {tab.label}
                            {tab.badge && (
                                <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-hui-primary rounded-full" />
                            )}
                        </button>
                    ))}
                </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-hidden">
                {activeTab === "client" && (
                    <ClientMessaging
                        entityId={projectId}
                        entityType="project"
                        clientName={clientName}
                        clientEmail={clientEmail}
                        clientPhone={clientPhone}
                        estimates={estimates}
                        variant="sidebar"
                    />
                )}
                {activeTab === "team" && (
                    <TeamChat
                        projectId={projectId}
                        currentUserName={currentUserName}
                        onNewMessages={handleTeamNewMessages}
                        isActive={activeTab === "team"}
                    />
                )}
                {activeTab === "activity" && (
                    <ActivityFeed projectId={projectId} />
                )}
            </div>
        </div>
    );
}
