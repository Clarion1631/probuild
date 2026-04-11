"use client";

import { useEffect, useRef, useState, useCallback } from "react";

interface ActivityItem {
    id: string;
    actorType: string;
    actorName: string;
    action: string;
    entityType?: string | null;
    entityName?: string | null;
    metadata?: string | null;
    createdAt: string;
}

interface ActivityFeedProps {
    projectId: string;
}

const ACTION_CONFIG: Record<string, { icon: React.ReactNode; color: string; label: string }> = {
    viewed_estimate: {
        icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />,
        color: "bg-blue-100 text-blue-600",
        label: "viewed",
    },
    viewed_portal: {
        icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />,
        color: "bg-blue-100 text-blue-600",
        label: "visited the project portal",
    },
    viewed_contract: {
        icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />,
        color: "bg-blue-100 text-blue-600",
        label: "viewed",
    },
    signed_estimate: {
        icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />,
        color: "bg-green-100 text-green-600",
        label: "signed",
    },
    signed_contract: {
        icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />,
        color: "bg-green-100 text-green-600",
        label: "signed",
    },
    paid_invoice: {
        icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />,
        color: "bg-emerald-100 text-emerald-600",
        label: "paid",
    },
    sent_message: {
        icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />,
        color: "bg-orange-100 text-orange-600",
        label: "sent a message",
    },
    approved_change_order: {
        icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />,
        color: "bg-green-100 text-green-600",
        label: "approved",
    },
    sent_estimate: {
        icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />,
        color: "bg-indigo-100 text-indigo-600",
        label: "sent",
    },
    sent_contract: {
        icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />,
        color: "bg-indigo-100 text-indigo-600",
        label: "sent",
    },
    sent_invoice: {
        icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />,
        color: "bg-indigo-100 text-indigo-600",
        label: "sent",
    },
};

function getConfig(action: string) {
    return ACTION_CONFIG[action] || {
        icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />,
        color: "bg-slate-100 text-slate-500",
        label: action.replace(/_/g, " "),
    };
}

function formatRelativeTime(dateStr: string): string {
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7) return d.toLocaleDateString("en-US", { weekday: "short" });
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function ActivityFeed({ projectId }: ActivityFeedProps) {
    const [activities, setActivities] = useState<ActivityItem[]>([]);
    const [loading, setLoading] = useState(true);
    const pollRef = useRef<NodeJS.Timeout | null>(null);

    const fetchActivities = useCallback(async () => {
        try {
            const res = await fetch(`/api/activity?projectId=${projectId}`);
            if (!res.ok) return;
            const data = await res.json();
            setActivities(data.activities || []);
        } catch (err) {
            console.error("[ActivityFeed] Failed to fetch:", err);
        } finally {
            setLoading(false);
        }
    }, [projectId]);

    useEffect(() => {
        fetchActivities();
        pollRef.current = setInterval(fetchActivities, 30000);
        return () => {
            if (pollRef.current) clearInterval(pollRef.current);
        };
    }, [fetchActivities]);

    if (loading) {
        return (
            <div className="flex items-center justify-center h-full">
                <div className="flex flex-col items-center gap-3">
                    <div className="w-8 h-8 border-2 border-hui-primary border-t-transparent rounded-full animate-spin" />
                    <p className="text-sm text-hui-textMuted">Loading activity...</p>
                </div>
            </div>
        );
    }

    if (activities.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center h-full px-6 text-center">
                <div className="w-14 h-14 bg-slate-100 rounded-2xl flex items-center justify-center mb-4">
                    <svg className="w-7 h-7 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                </div>
                <p className="text-sm font-medium text-hui-textMuted mb-1">No client activity yet</p>
                <p className="text-xs text-slate-400">Activity will appear here as the client interacts with the project</p>
            </div>
        );
    }

    // Group by date
    const grouped: { date: string; items: ActivityItem[] }[] = [];
    let lastDate = "";
    for (const item of activities) {
        const date = new Date(item.createdAt).toDateString();
        if (date !== lastDate) {
            grouped.push({ date, items: [item] });
            lastDate = date;
        } else {
            grouped[grouped.length - 1].items.push(item);
        }
    }

    return (
        <div className="h-full overflow-y-auto px-4 py-3 bg-white">
            {grouped.map((group) => (
                <div key={group.date} className="mb-4">
                    {/* Date header */}
                    <div className="flex items-center gap-2 mb-3">
                        <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                            {(() => {
                                const d = new Date(group.date);
                                const today = new Date();
                                const yesterday = new Date(today);
                                yesterday.setDate(yesterday.getDate() - 1);
                                if (d.toDateString() === today.toDateString()) return "Today";
                                if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
                                return d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
                            })()}
                        </span>
                        <div className="flex-1 h-px bg-slate-100" />
                    </div>

                    {/* Activity items */}
                    <div className="space-y-1">
                        {group.items.map((item) => {
                            const config = getConfig(item.action);
                            const description = item.entityName
                                ? `${config.label} ${item.entityName}`
                                : config.label;

                            return (
                                <div
                                    key={item.id}
                                    className="flex items-start gap-3 py-2 px-2 rounded-lg hover:bg-slate-50 transition-colors"
                                >
                                    {/* Icon */}
                                    <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${config.color}`}>
                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            {config.icon}
                                        </svg>
                                    </div>

                                    {/* Content */}
                                    <div className="flex-1 min-w-0">
                                        <p className="text-sm text-hui-textMain leading-snug">
                                            <span className="font-semibold">{item.actorName}</span>{" "}
                                            <span className="text-hui-textMuted">{description}</span>
                                        </p>
                                        {item.metadata && (() => {
                                            try {
                                                const meta = JSON.parse(item.metadata);
                                                if (meta.amount) {
                                                    return (
                                                        <p className="text-xs text-emerald-600 font-medium mt-0.5">
                                                            ${Number(meta.amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}
                                                        </p>
                                                    );
                                                }
                                            } catch { /* ignore */ }
                                            return null;
                                        })()}
                                    </div>

                                    {/* Time */}
                                    <span className="text-[10px] text-slate-400 shrink-0 mt-0.5">
                                        {formatRelativeTime(item.createdAt)}
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                </div>
            ))}
        </div>
    );
}
