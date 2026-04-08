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
    onToggle?: () => void;
    unreadCount?: number;
}

export default function ProjectMessagingPanel({
    projectId, clientName, clientEmail, clientPhone, estimates,
    currentUserName, currentUserEmail, onToggle, unreadCount = 0,
}: ProjectMessagingPanelProps) {
    const [activeTab, setActiveTab] = useState<"client" | "team" | "activity">("client");
    const [teamUnread, setTeamUnread] = useState(0);
    const [participants, setParticipants] = useState<string[]>([]);

    const handleTeamNewMessages = useCallback((count: number) => {
        setTeamUnread(count === 0 ? 0 : (prev: number) => prev + count);
    }, []);

    const handleParticipantsChange = useCallback((names: string[]) => {
        setParticipants(names);
    }, []);

    const getInitials = (name: string) => {
        const parts = name.split(" ").filter(Boolean);
        if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
        return (parts[0]?.[0] || "?").toUpperCase();
    };

    const getAvatarColor = (name: string) => {
        const colors = [
            "bg-blue-500", "bg-violet-500", "bg-amber-500",
            "bg-rose-500", "bg-teal-500", "bg-indigo-500", "bg-orange-500",
        ];
        let hash = 0;
        for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
        return colors[Math.abs(hash) % colors.length];
    };

    const tabs = [
        { key: "client" as const, label: "Client", badge: unreadCount > 0, badgeCount: unreadCount },
        { key: "team" as const, label: "Team", badge: teamUnread > 0, badgeCount: teamUnread },
        { key: "activity" as const, label: "Activity", badge: false, badgeCount: 0 },
    ];

    const allParticipants = currentUserName
        ? [currentUserName, ...participants.filter(p => p !== currentUserName)]
        : participants;
    const visibleParticipants = allParticipants.slice(0, 5);
    const hiddenCount = allParticipants.length - visibleParticipants.length;

    return (
        <div className="h-full flex flex-col border-l border-slate-200 bg-white">
            {/* Header: tab bar + chat bubble toggle */}
            <div className="flex items-center gap-2 px-3 py-2.5 border-b border-slate-200 bg-white shrink-0">
                <div className="flex items-center gap-1 bg-slate-100 rounded-lg p-1 flex-1 min-w-0">
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
                                <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] flex items-center justify-center text-[9px] font-bold bg-red-500 text-white rounded-full px-0.5 leading-none">
                                    {tab.badgeCount > 99 ? "99+" : tab.badgeCount}
                                </span>
                            )}
                        </button>
                    ))}
                </div>

                {/* Chat bubble — the only collapse toggle */}
                {onToggle && (
                    <button
                        onClick={onToggle}
                        aria-label="Collapse messages"
                        title="Collapse messages"
                        className="shrink-0 p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-hui-primary transition"
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/>
                        </svg>
                    </button>
                )}
            </div>

            {/* Team tab: participant avatars strip */}
            {activeTab === "team" && (
                <div className="flex items-center gap-2 px-4 py-2 border-b border-slate-100 bg-slate-50/60 shrink-0">
                    <div className="flex items-center -space-x-1">
                        {visibleParticipants.map((name) => (
                            <div
                                key={name}
                                title={name === currentUserName ? `${name} (you)` : name}
                                className={`w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-bold text-white ring-2 ring-white ${
                                    name === currentUserName ? "bg-hui-primary" : getAvatarColor(name)
                                }`}
                            >
                                {getInitials(name)}
                            </div>
                        ))}
                        {hiddenCount > 0 && (
                            <div className="w-6 h-6 rounded-full bg-slate-200 flex items-center justify-center text-[9px] font-bold text-slate-500 ring-2 ring-white">
                                +{hiddenCount}
                            </div>
                        )}
                    </div>
                    <span className="text-[11px] text-slate-400 truncate">
                        {allParticipants.length <= 1
                            ? "Just you so far — message your team"
                            : `${allParticipants.length} team members`}
                    </span>
                </div>
            )}

            {/* Content */}
            <div className="flex-1 min-h-0 overflow-hidden">
                <div className={activeTab === "client" ? "h-full" : "hidden"}>
                    <ClientMessaging
                        entityId={projectId}
                        entityType="project"
                        clientName={clientName}
                        clientEmail={clientEmail}
                        clientPhone={clientPhone}
                        estimates={estimates}
                        variant="sidebar"
                    />
                </div>
                {/* TeamChat is always mounted so polling runs and the unread badge works */}
                <div className={activeTab === "team" ? "h-full" : "hidden"}>
                    <TeamChat
                        projectId={projectId}
                        currentUserName={currentUserName}
                        onNewMessages={handleTeamNewMessages}
                        isActive={activeTab === "team"}
                        onParticipantsChange={handleParticipantsChange}
                    />
                </div>
                <div className={activeTab === "activity" ? "h-full" : "hidden"}>
                    <ActivityFeed projectId={projectId} />
                </div>
            </div>
        </div>
    );
}
