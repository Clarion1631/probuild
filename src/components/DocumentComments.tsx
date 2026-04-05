"use client";

import { useState, useEffect } from "react";
import { getDocumentComments, addDocumentComment, deleteDocumentComment } from "@/lib/actions";
import { toast } from "sonner";

type Comment = {
    id: string;
    text: string;
    visibility: string;
    authorId: string | null;
    authorName: string | null;
    author: { id: string; name: string | null; email: string } | null;
    createdAt: string;
};

export default function DocumentComments({
    documentType,
    documentId,
    currentUserId,
    currentUserName,
    showClientTab = true,
}: {
    documentType: string;
    documentId: string;
    currentUserId?: string;
    currentUserName?: string;
    showClientTab?: boolean;
}) {
    const [comments, setComments] = useState<Comment[]>([]);
    const [activeTab, setActiveTab] = useState<"team" | "client">("team");
    const [newText, setNewText] = useState("");
    const [isLoading, setIsLoading] = useState(true);
    const [isSending, setIsSending] = useState(false);

    useEffect(() => {
        setIsLoading(true);
        getDocumentComments(documentType, documentId)
            .then((data) => setComments(data.map((c: any) => ({ ...c, createdAt: c.createdAt?.toISOString?.() || c.createdAt }))))
            .catch(() => toast.error("Failed to load comments"))
            .finally(() => setIsLoading(false));
    }, [documentType, documentId]);

    async function handleSend() {
        const text = newText.trim();
        if (!text) return;
        setIsSending(true);
        try {
            const comment = await addDocumentComment(
                documentType,
                documentId,
                text,
                activeTab,
                currentUserId,
                currentUserName,
            );
            setComments((prev) => [...prev, { ...comment, createdAt: (comment as any).createdAt?.toISOString?.() || String((comment as any).createdAt) }]);
            setNewText("");
        } catch {
            toast.error("Failed to send comment");
        } finally {
            setIsSending(false);
        }
    }

    async function handleDelete(id: string) {
        if (!confirm("Delete this comment?")) return;
        try {
            await deleteDocumentComment(id);
            setComments((prev) => prev.filter((c) => c.id !== id));
        } catch {
            toast.error("Failed to delete comment");
        }
    }

    const filtered = comments.filter((c) => c.visibility === activeTab);

    function getAuthorDisplay(c: Comment) {
        if (c.author?.name) return c.author.name;
        if (c.authorName) return c.authorName;
        if (c.author?.email) return c.author.email;
        return "Unknown";
    }

    function getInitials(c: Comment) {
        const name = c.author?.name || c.authorName || c.author?.email || "?";
        return name.split(" ").map((w) => w[0]).join("").toUpperCase().slice(0, 2);
    }

    function formatTime(iso: string) {
        const d = new Date(iso);
        const now = new Date();
        const diffMs = now.getTime() - d.getTime();
        const diffMins = Math.floor(diffMs / 60000);
        if (diffMins < 1) return "Just now";
        if (diffMins < 60) return `${diffMins}m ago`;
        const diffHours = Math.floor(diffMins / 60);
        if (diffHours < 24) return `${diffHours}h ago`;
        return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    }

    return (
        <div className="flex flex-col h-full">
            {/* Tabs */}
            <div className="flex border-b border-slate-200">
                <button
                    onClick={() => setActiveTab("team")}
                    className={`flex-1 px-4 py-2.5 text-sm font-medium transition border-b-2 ${
                        activeTab === "team"
                            ? "border-blue-500 text-blue-700 bg-blue-50/50"
                            : "border-transparent text-slate-500 hover:text-slate-700"
                    }`}
                >
                    <span className="flex items-center justify-center gap-1.5">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
                        </svg>
                        Team
                        {comments.filter((c) => c.visibility === "team").length > 0 && (
                            <span className="bg-blue-100 text-blue-700 text-[10px] font-bold rounded-full px-1.5 py-0.5 min-w-[18px] text-center">
                                {comments.filter((c) => c.visibility === "team").length}
                            </span>
                        )}
                    </span>
                </button>
                {showClientTab && (
                    <button
                        onClick={() => setActiveTab("client")}
                        className={`flex-1 px-4 py-2.5 text-sm font-medium transition border-b-2 ${
                            activeTab === "client"
                                ? "border-emerald-500 text-emerald-700 bg-emerald-50/50"
                                : "border-transparent text-slate-500 hover:text-slate-700"
                        }`}
                    >
                        <span className="flex items-center justify-center gap-1.5">
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                            </svg>
                            Client
                            {comments.filter((c) => c.visibility === "client").length > 0 && (
                                <span className="bg-emerald-100 text-emerald-700 text-[10px] font-bold rounded-full px-1.5 py-0.5 min-w-[18px] text-center">
                                    {comments.filter((c) => c.visibility === "client").length}
                                </span>
                            )}
                        </span>
                    </button>
                )}
            </div>

            {/* Visibility hint */}
            <div className={`px-4 py-1.5 text-[11px] font-medium ${
                activeTab === "team" ? "bg-blue-50 text-blue-600" : "bg-emerald-50 text-emerald-600"
            }`}>
                {activeTab === "team" ? "Only your team can see these comments" : "Client can see these comments"}
            </div>

            {/* Comment list */}
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
                {isLoading ? (
                    <div className="text-center py-8 text-sm text-slate-400">Loading...</div>
                ) : filtered.length === 0 ? (
                    <div className="text-center py-8">
                        <svg className="w-8 h-8 mx-auto text-slate-300 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                        </svg>
                        <p className="text-sm text-slate-400">No {activeTab} comments yet</p>
                    </div>
                ) : (
                    filtered.map((c) => (
                        <div key={c.id} className="flex gap-2.5 group">
                            <div className={`w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0 mt-0.5 ${
                                activeTab === "team" ? "bg-blue-100 text-blue-700" : "bg-emerald-100 text-emerald-700"
                            }`}>
                                {getInitials(c)}
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className="flex items-baseline gap-2">
                                    <span className="text-xs font-semibold text-slate-700">{getAuthorDisplay(c)}</span>
                                    <span className="text-[10px] text-slate-400">{formatTime(c.createdAt)}</span>
                                    {c.authorId === currentUserId && (
                                        <button
                                            onClick={() => handleDelete(c.id)}
                                            className="text-[10px] text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition ml-auto"
                                        >
                                            Delete
                                        </button>
                                    )}
                                </div>
                                <p className="text-sm text-slate-600 mt-0.5 whitespace-pre-wrap break-words">{c.text}</p>
                            </div>
                        </div>
                    ))
                )}
            </div>

            {/* Input */}
            <div className="border-t border-slate-200 p-3">
                <div className="flex gap-2">
                    <textarea
                        value={newText}
                        onChange={(e) => setNewText(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                        placeholder={`Add a ${activeTab} comment...`}
                        rows={1}
                        className="flex-1 border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-300 focus:border-blue-300 resize-none"
                    />
                    <button
                        onClick={handleSend}
                        disabled={isSending || !newText.trim()}
                        className={`px-3 py-2 rounded-lg text-sm font-medium transition disabled:opacity-40 ${
                            activeTab === "team"
                                ? "bg-blue-600 text-white hover:bg-blue-700"
                                : "bg-emerald-600 text-white hover:bg-emerald-700"
                        }`}
                    >
                        {isSending ? "..." : "Send"}
                    </button>
                </div>
            </div>
        </div>
    );
}
