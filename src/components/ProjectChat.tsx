"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { toast } from "sonner";

interface MessageData {
    id: string;
    // SYSTEM = auto-generated activity banner (e.g. contract sent/signed).
    // Written by postActivityToThread in src/lib/actions.ts — rendered as a
    // centered subdued pill, not as a chat bubble.
    senderType: "CLIENT" | "TEAM" | "SYSTEM";
    senderName: string;
    senderEmail?: string;
    body: string;
    readAt: string | null;
    createdAt: string;
}

interface ProjectChatProps {
    projectId: string;
    perspective: "TEAM" | "CLIENT" | "SUBCONTRACTOR";
    subcontractorId?: string;
    currentUserName?: string;
    currentUserEmail?: string;
}

export default function ProjectChat({
    projectId,
    perspective,
    subcontractorId,
    currentUserName = "Team Member",
    currentUserEmail,
}: ProjectChatProps) {
    const [messages, setMessages] = useState<MessageData[]>([]);
    const [newMessage, setNewMessage] = useState("");
    const [sending, setSending] = useState(false);
    const [loading, setLoading] = useState(true);
    const scrollRef = useRef<HTMLDivElement>(null);
    const pollRef = useRef<NodeJS.Timeout | null>(null);

    const fetchMessages = useCallback(async () => {
        try {
            const url = subcontractorId 
                ? `/api/messages?projectId=${projectId}&subcontractorId=${subcontractorId}`
                : `/api/messages?projectId=${projectId}`;
            const res = await fetch(url);
            if (!res.ok) return;
            const data = await res.json();
            setMessages(data.messages || []);

            // Mark unread messages from the OTHER side as read.
            // SYSTEM banners are activity log entries, not real incoming
            // messages — skip the PATCH so they don't churn read timestamps.
            const unread = (data.messages || []).filter(
                (m: MessageData) =>
                    m.senderType !== perspective && m.senderType !== "SYSTEM" && !m.readAt
            );
            for (const msg of unread) {
                fetch(`/api/messages/${msg.id}/read`, { method: "PATCH" }).catch((err) => console.error("[Chat] Failed to mark as read:", err));
            }
        } catch (err) {
            console.error("[Chat] Failed to fetch messages:", err);
            toast.error("Failed to load messages");
        } finally {
            setLoading(false);
        }
    }, [projectId, perspective, subcontractorId]);

    useEffect(() => {
        fetchMessages();
        pollRef.current = setInterval(fetchMessages, 5000);
        return () => {
            if (pollRef.current) clearInterval(pollRef.current);
        };
    }, [fetchMessages]);

    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [messages]);

    const handleSend = async () => {
        const text = newMessage.trim();
        if (!text || sending) return;

        setSending(true);
        try {
            const res = await fetch("/api/messages", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    projectId,
                    body: text,
                    senderType: perspective,
                    senderName: currentUserName,
                    senderEmail: currentUserEmail,
                    subcontractorId,
                }),
            });
            if (res.ok) {
                const msg = await res.json();
                setMessages((prev) => [...prev, msg]);
                setNewMessage("");
            }
        } catch (err) {
            console.error("[Chat] Failed to send message:", err);
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

    const isOwnMessage = (msg: MessageData) => msg.senderType === perspective;

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
            <div className="hui-card flex items-center justify-center py-16">
                <div className="flex flex-col items-center gap-3">
                    <div className="w-8 h-8 border-2 border-hui-primary border-t-transparent rounded-full animate-spin" />
                    <p className="text-sm text-hui-textMuted">Loading messages...</p>
                </div>
            </div>
        );
    }

    return (
        <div className="hui-card flex flex-col" style={{ height: "calc(100vh - 220px)", minHeight: "400px" }}>
            {/* Header */}
            <div className="px-5 py-3 border-b border-hui-border bg-white rounded-t-lg flex items-center gap-3">
                <div className="w-8 h-8 bg-hui-primary/10 rounded-lg flex items-center justify-center">
                    <svg className="w-4 h-4 text-hui-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                    </svg>
                </div>
                <div>
                    <h3 className="text-sm font-semibold text-hui-textMain">
                        {perspective === "TEAM" ? "Team Chat" : "Project Messages"}
                    </h3>
                    <p className="text-xs text-hui-textMuted">
                        {messages.length} message{messages.length !== 1 ? "s" : ""}
                    </p>
                </div>
            </div>

            {/* Messages */}
            <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-3 bg-slate-50/50">
                {messages.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full text-center py-12">
                        <div className="w-16 h-16 bg-slate-100 rounded-2xl flex items-center justify-center mb-4">
                            <svg className="w-8 h-8 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                            </svg>
                        </div>
                        <p className="text-sm font-medium text-hui-textMuted mb-1">No messages yet</p>
                        <p className="text-xs text-slate-400">
                            {perspective === "TEAM" ? "Send a message to the team" : "Start the conversation"}
                        </p>
                    </div>
                ) : (
                    messages.map((msg, idx) => {
                        const own = isOwnMessage(msg);
                        const isSystem = msg.senderType === "SYSTEM";
                        // Show date separator
                        const showDate = idx === 0 ||
                            new Date(msg.createdAt).toDateString() !== new Date(messages[idx - 1].createdAt).toDateString();

                        // SYSTEM activity banners (contract sent/viewed/signed, etc.)
                        // render as a centered subdued pill instead of a chat bubble.
                        // Body is server-generated plain text from postActivityToThread —
                        // safe to render as text (no HTML, no user input).
                        if (isSystem) {
                            return (
                                <div key={msg.id}>
                                    {showDate && (
                                        <div className="flex items-center justify-center py-2">
                                            <span className="text-[10px] font-medium text-slate-400 bg-white px-3 py-1 rounded-full border border-slate-200 shadow-sm">
                                                {new Date(msg.createdAt).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}
                                            </span>
                                        </div>
                                    )}
                                    <div className="flex justify-center my-1">
                                        <div className="max-w-[80%] text-center text-xs text-slate-500 bg-slate-100 border border-slate-200 rounded-full px-4 py-1.5">
                                            <span className="whitespace-pre-wrap">{msg.body ?? ""}</span>
                                            <span className="ml-2 text-slate-400">· {formatTime(msg.createdAt)}</span>
                                        </div>
                                    </div>
                                </div>
                            );
                        }

                        return (
                            <div key={msg.id}>
                                {showDate && (
                                    <div className="flex items-center justify-center py-2">
                                        <span className="text-[10px] font-medium text-slate-400 bg-white px-3 py-1 rounded-full border border-slate-200 shadow-sm">
                                            {new Date(msg.createdAt).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}
                                        </span>
                                    </div>
                                )}
                                <div className={`flex ${own ? "justify-end" : "justify-start"}`}>
                                    <div className={`max-w-[75%] group`}>
                                        {!own && (
                                            <p className="text-[10px] font-semibold text-slate-500 mb-1 ml-1">
                                                {msg.senderName}
                                            </p>
                                        )}
                                        <div
                                            className={`px-4 py-2.5 rounded-2xl text-sm leading-relaxed shadow-sm ${
                                                own
                                                    ? msg.senderType === "TEAM"
                                                        ? "bg-hui-primary text-white rounded-br-md"
                                                        : "bg-blue-500 text-white rounded-br-md"
                                                    : "bg-white text-hui-textMain border border-slate-200 rounded-bl-md"
                                            }`}
                                        >
                                            {msg.body}
                                        </div>
                                        <div className={`flex items-center gap-1.5 mt-0.5 ${own ? "justify-end" : "justify-start"}`}>
                                            <span className="text-[10px] text-slate-400">
                                                {formatTime(msg.createdAt)}
                                            </span>
                                            {own && msg.readAt && (
                                                <svg className="w-3 h-3 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                                                </svg>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        );
                    })
                )}
            </div>

            {/* Input */}
            <div className="px-4 py-3 border-t border-hui-border bg-white rounded-b-lg">
                <div className="flex items-end gap-2">
                    <div className="flex-1 relative">
                        <textarea
                            value={newMessage}
                            onChange={(e) => setNewMessage(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder="Type a message..."
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
