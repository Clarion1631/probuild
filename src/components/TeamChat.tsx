"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { toast } from "sonner";

interface TeamMessageData {
    id: string;
    authorName: string;
    body: string;
    createdAt: string;
}

interface TeamChatProps {
    projectId: string;
    currentUserName?: string;
    onNewMessages?: (count: number) => void;
    onParticipantsChange?: (names: string[]) => void;
    isActive?: boolean;
}

export default function TeamChat({
    projectId,
    currentUserName = "Team Member",
    onNewMessages,
    onParticipantsChange,
    isActive = true,
}: TeamChatProps) {
    const [messages, setMessages] = useState<TeamMessageData[]>([]);
    const [newMessage, setNewMessage] = useState("");
    const [sending, setSending] = useState(false);
    const [loading, setLoading] = useState(true);
    const scrollRef = useRef<HTMLDivElement>(null);
    const pollRef = useRef<NodeJS.Timeout | null>(null);
    const prevCountRef = useRef(0);
    const prevParticipantsRef = useRef("");

    const fetchMessages = useCallback(async (signal?: AbortSignal) => {
        try {
            const res = await fetch(`/api/team-messages?projectId=${projectId}`, { signal });
            if (!res.ok) return;
            const data = await res.json();
            const msgs: TeamMessageData[] = data.messages || [];
            setMessages(msgs);

            // Notify parent of new messages when tab is not active
            if (!isActive && onNewMessages && msgs.length > prevCountRef.current) {
                onNewMessages(msgs.length - prevCountRef.current);
            }
            prevCountRef.current = msgs.length;

            // Derive unique participants (excluding current user) and notify parent
            if (onParticipantsChange) {
                const others = Array.from(
                    new Set(msgs.map((m) => m.authorName).filter((n) => n !== currentUserName))
                );
                const serialized = JSON.stringify([...others].sort());
                if (serialized !== prevParticipantsRef.current) {
                    prevParticipantsRef.current = serialized;
                    onParticipantsChange(others);
                }
            }
        } catch (err) {
            if (err instanceof Error && err.name === "AbortError") return;
            console.error("[TeamChat] Failed to fetch:", err);
        } finally {
            setLoading(false);
        }
    }, [projectId, isActive, onNewMessages, onParticipantsChange, currentUserName]);

    useEffect(() => {
        const controller = new AbortController();
        fetchMessages(controller.signal);
        pollRef.current = setInterval(() => fetchMessages(controller.signal), 5000);
        return () => {
            if (pollRef.current) clearInterval(pollRef.current);
            controller.abort();
        };
    }, [fetchMessages]);

    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [messages]);

    // Reset unread when tab becomes active
    useEffect(() => {
        if (isActive && onNewMessages) {
            onNewMessages(0);
        }
    }, [isActive, onNewMessages]);

    const handleSend = async () => {
        const text = newMessage.trim();
        if (!text || sending) return;

        setSending(true);
        try {
            const res = await fetch("/api/team-messages", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ projectId, body: text }),
            });
            if (res.ok) {
                const msg = await res.json();
                setMessages((prev) => [...prev, msg]);
                prevCountRef.current += 1;
                setNewMessage("");
            }
        } catch (err) {
            console.error("[TeamChat] Failed to send:", err);
            toast.error("Failed to send message");
        } finally {
            setSending(false);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    const isOwnMessage = (msg: TeamMessageData) => msg.authorName === currentUserName;

    const getInitials = (name: string) => {
        const parts = name.split(" ").filter(Boolean);
        if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
        return (parts[0]?.[0] || "?").toUpperCase();
    };

    const formatTime = (dateStr: string) => {
        const d = new Date(dateStr);
        const now = new Date();
        const diffMs = now.getTime() - d.getTime();
        const diffDays = Math.floor(diffMs / 86400000);

        if (diffDays === 0) {
            return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
        } else if (diffDays === 1) {
            return "Yesterday " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
        } else if (diffDays < 7) {
            return d.toLocaleDateString("en-US", { weekday: "short" }) + " " +
                d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
        }
        return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " " +
            d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center h-full">
                <div className="flex flex-col items-center gap-3">
                    <div className="w-8 h-8 border-2 border-hui-primary border-t-transparent rounded-full animate-spin" />
                    <p className="text-sm text-hui-textMuted">Loading messages...</p>
                </div>
            </div>
        );
    }

    return (
        <div className="h-full flex flex-col bg-white">
            {/* Messages */}
            <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3 bg-slate-50/50">
                {messages.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full text-center py-12">
                        <div className="w-14 h-14 bg-slate-100 rounded-2xl flex items-center justify-center mb-4">
                            <svg className="w-7 h-7 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
                            </svg>
                        </div>
                        <p className="text-sm font-medium text-hui-textMuted mb-1">No team messages yet</p>
                        <p className="text-xs text-slate-400">Start the conversation with your team</p>
                    </div>
                ) : (
                    messages.map((msg, idx) => {
                        const own = isOwnMessage(msg);
                        const showDate = idx === 0 ||
                            new Date(msg.createdAt).toDateString() !== new Date(messages[idx - 1].createdAt).toDateString();

                        return (
                            <div key={msg.id}>
                                {showDate && (
                                    <div className="flex items-center justify-center py-2">
                                        <span className="text-[10px] font-medium text-slate-400 bg-white px-3 py-1 rounded-full border border-slate-200 shadow-sm">
                                            {new Date(msg.createdAt).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}
                                        </span>
                                    </div>
                                )}
                                <div className={`flex ${own ? "justify-end" : "justify-start"} gap-2`}>
                                    {!own && (
                                        <div className="w-7 h-7 rounded-full bg-slate-200 flex items-center justify-center shrink-0 mt-5">
                                            <span className="text-[10px] font-bold text-slate-600">
                                                {getInitials(msg.authorName)}
                                            </span>
                                        </div>
                                    )}
                                    <div className="max-w-[75%]">
                                        {!own && (
                                            <p className="text-[10px] font-semibold text-slate-500 mb-1 ml-1">
                                                {msg.authorName}
                                            </p>
                                        )}
                                        <div
                                            className={`px-4 py-2.5 rounded-2xl text-sm leading-relaxed shadow-sm ${
                                                own
                                                    ? "bg-hui-primary text-white rounded-br-md"
                                                    : "bg-white text-hui-textMain border border-slate-200 rounded-bl-md"
                                            }`}
                                        >
                                            {msg.body}
                                        </div>
                                        <div className={`flex items-center mt-0.5 ${own ? "justify-end" : "justify-start"}`}>
                                            <span className="text-[10px] text-slate-400">
                                                {formatTime(msg.createdAt)}
                                            </span>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        );
                    })
                )}
            </div>

            {/* Input — pinned to bottom */}
            <div className="shrink-0 px-3 py-2.5 border-t border-hui-border bg-white">
                <div className="flex items-end gap-2">
                    <div className="flex-1">
                        <textarea
                            value={newMessage}
                            onChange={(e) => setNewMessage(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder="Message your team..."
                            rows={1}
                            className="hui-input w-full resize-none pr-3 py-2.5 text-sm min-h-[40px] max-h-[120px]"
                            style={{ lineHeight: "1.4" }}
                        />
                    </div>
                    <button
                        onClick={handleSend}
                        disabled={!newMessage.trim() || sending}
                        className={`hui-btn shrink-0 h-10 w-10 flex items-center justify-center rounded-lg transition-all ${
                            newMessage.trim() && !sending
                                ? "hui-btn-green"
                                : "bg-slate-100 text-slate-400 cursor-not-allowed"
                        }`}
                    >
                        {sending ? (
                            <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                        ) : (
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                            </svg>
                        )}
                    </button>
                </div>
            </div>
        </div>
    );
}
