"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { markFieldUpdatesSeen } from "@/lib/actions";
import { toast } from "sonner";

type FeedComment = {
    id: string;
    text: string;
    createdAt: string;
    authorName: string;
    authorEmail: string | null;
    photos: { id: string; url: string }[];
    task: { id: string; name: string; projectId: string; projectName: string } | null;
};

type Props = {
    initialComments: FeedComment[];
    initialUnread: number;
    scope: "all" | "scoped" | "none";
};

function initialsOf(name: string, email: string | null) {
    const trimmed = name.trim();
    if (trimmed && trimmed !== "Unknown") {
        return trimmed.split(/\s+/).map(p => p[0]).join("").toUpperCase().slice(0, 2);
    }
    if (email) return email[0]?.toUpperCase() ?? "?";
    return "?";
}

function groupByDay(comments: FeedComment[]) {
    const groups: Record<string, FeedComment[]> = {};
    for (const c of comments) {
        const d = new Date(c.createdAt);
        const key = d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
        groups[key] ??= [];
        groups[key].push(c);
    }
    return groups;
}

function relativeTime(iso: string) {
    const now = Date.now();
    const then = new Date(iso).getTime();
    const diffMin = Math.floor((now - then) / 60000);
    if (diffMin < 1) return "just now";
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export default function FieldUpdatesClient({ initialComments, initialUnread, scope }: Props) {
    const [comments] = useState(initialComments);
    const [unreadCount, setUnreadCount] = useState(initialUnread);
    const [projectFilter, setProjectFilter] = useState<string | "all">("all");
    const [seenAt, setSeenAt] = useState<number | null>(null);
    const [isMarking, startMark] = useTransition();
    const [lightbox, setLightbox] = useState<string | null>(null);

    const projects = useMemo(() => {
        const map = new Map<string, string>();
        for (const c of comments) if (c.task) map.set(c.task.projectId, c.task.projectName || c.task.projectId);
        return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
    }, [comments]);

    const filtered = useMemo(() => {
        if (projectFilter === "all") return comments;
        return comments.filter(c => c.task?.projectId === projectFilter);
    }, [comments, projectFilter]);

    const groups = useMemo(() => groupByDay(filtered), [filtered]);

    // Auto-mark seen when the page is first opened — the unread count snapshot stays so
    // the user can see what *was* new on this visit even after we update the timestamp.
    useEffect(() => {
        if (initialUnread > 0 && seenAt === null) {
            startMark(async () => {
                const res = await markFieldUpdatesSeen();
                if (res.ok) {
                    setSeenAt(Date.now());
                    setUnreadCount(0);
                }
            });
        } else if (initialUnread === 0 && seenAt === null) {
            setSeenAt(Date.now());
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <div className="p-6 max-w-5xl mx-auto">
            <div className="flex items-center justify-between mb-4">
                <div>
                    <h1 className="text-2xl font-bold text-hui-textMain">Field Updates</h1>
                    <p className="text-sm text-hui-textMuted mt-0.5">
                        Recent comments and photos from the field {scope === "scoped" ? "across your projects" : "across all projects"}.
                        {initialUnread > 0 && <> <span className="text-hui-primary font-semibold">{initialUnread} new since your last visit.</span></>}
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => {
                        startMark(async () => {
                            const res = await markFieldUpdatesSeen();
                            if (res.ok) {
                                setUnreadCount(0);
                                setSeenAt(Date.now());
                                toast.success("Marked as read");
                            } else {
                                toast.error("Failed to mark as read");
                            }
                        });
                    }}
                    disabled={isMarking || unreadCount === 0}
                    className="hui-btn hui-btn-secondary text-xs disabled:opacity-50"
                >
                    {unreadCount > 0 ? `Mark ${unreadCount} as read` : "All caught up"}
                </button>
            </div>

            {projects.length > 1 && (
                <div className="flex gap-1.5 mb-4 flex-wrap">
                    <button
                        type="button"
                        onClick={() => setProjectFilter("all")}
                        className={`text-xs px-2.5 py-1 rounded-full border transition ${projectFilter === "all" ? "bg-hui-primary text-white border-hui-primary" : "bg-white text-hui-textMuted border-hui-border hover:border-hui-primary"}`}
                    >
                        All projects ({comments.length})
                    </button>
                    {projects.map(p => {
                        const count = comments.filter(c => c.task?.projectId === p.id).length;
                        return (
                            <button
                                key={p.id}
                                type="button"
                                onClick={() => setProjectFilter(p.id)}
                                className={`text-xs px-2.5 py-1 rounded-full border transition ${projectFilter === p.id ? "bg-hui-primary text-white border-hui-primary" : "bg-white text-hui-textMuted border-hui-border hover:border-hui-primary"}`}
                            >
                                {p.name} ({count})
                            </button>
                        );
                    })}
                </div>
            )}

            {filtered.length === 0 ? (
                <div className="text-center text-hui-textMuted py-16">
                    <p className="text-sm">No field updates yet.</p>
                    <p className="text-xs mt-1 text-slate-400">Comments and photos posted from the field will appear here.</p>
                </div>
            ) : (
                <div className="space-y-6">
                    {Object.entries(groups).map(([day, items]) => (
                        <div key={day}>
                            <h2 className="text-xs font-semibold uppercase tracking-wider text-hui-textMuted mb-2 pl-1">{day}</h2>
                            <ul className="space-y-2">
                                {items.map(c => {
                                    const isNew = new Date(c.createdAt).getTime() > (seenAt ?? Date.now()) - 1; // shows badge only for the brief moment before seenAt is set
                                    return (
                                        <li key={c.id} className="hui-card p-3 hover:shadow-sm transition">
                                            <div className="flex gap-3">
                                                <div className="w-8 h-8 rounded-full bg-indigo-100 text-indigo-700 text-[10px] font-bold flex items-center justify-center shrink-0">
                                                    {initialsOf(c.authorName, c.authorEmail)}
                                                </div>
                                                <div className="flex-1 min-w-0">
                                                    <div className="flex items-center gap-2 flex-wrap">
                                                        <span className="text-sm font-semibold text-hui-textMain">{c.authorName}</span>
                                                        <span className="text-xs text-slate-400">{relativeTime(c.createdAt)}</span>
                                                        {isNew && <span className="text-[9px] uppercase font-bold tracking-wider bg-hui-primary text-white px-1.5 py-0.5 rounded">New</span>}
                                                    </div>
                                                    {c.task && (
                                                        <div className="text-xs text-hui-textMuted mt-0.5">
                                                            <Link href={`/projects/${c.task.projectId}/schedule`} className="hover:text-hui-primary">
                                                                <span className="font-medium">{c.task.projectName}</span>
                                                                <span className="mx-1">·</span>
                                                                <span>{c.task.name}</span>
                                                            </Link>
                                                        </div>
                                                    )}
                                                    <p className="text-sm text-hui-textMain mt-1.5 whitespace-pre-wrap break-words">{c.text}</p>
                                                    {c.photos.length > 0 && (
                                                        <div className="mt-2 flex gap-2 flex-wrap">
                                                            {c.photos.map(p => (
                                                                <button
                                                                    key={p.id}
                                                                    type="button"
                                                                    onClick={() => setLightbox(p.url)}
                                                                    className="block focus:outline-none focus:ring-2 focus:ring-hui-primary rounded-md"
                                                                >
                                                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                                                    <img src={p.url} alt="" className="w-24 h-24 object-cover rounded-md border border-hui-border hover:opacity-90 transition" />
                                                                </button>
                                                            ))}
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        </li>
                                    );
                                })}
                            </ul>
                        </div>
                    ))}
                </div>
            )}

            {lightbox && (
                <div
                    role="dialog"
                    aria-modal="true"
                    className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
                    onClick={() => setLightbox(null)}
                >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={lightbox} alt="" className="max-w-full max-h-full object-contain" />
                </div>
            )}
        </div>
    );
}
