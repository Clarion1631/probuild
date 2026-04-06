"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { usePathname } from "next/navigation";
import { usePermissions } from "@/components/PermissionsProvider";

interface Message {
  role: "user" | "assistant";
  content: string;
  featureRequest?: { title: string; description: string };
}

interface ConversationSummary {
  id: string;
  title: string | null;
  updatedAt: string;
  archivedAt?: string | null;
  messageCount: number;
  matchPreview?: string;
  archived?: boolean;
}

interface HelpRequest {
  id: string;
  type: string;
  question: string;
  response: string | null;
  status: string;
  createdAt: string;
}

export default function HelpChatWidget({
  userId,
  userRole,
}: {
  userId?: string;
  userRole?: string;
}) {
  const { isAdmin, role, loaded } = usePermissions();
  const effectiveRole = userRole || role;
  const effectiveIsAdmin = userRole === "ADMIN" || isAdmin;

  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"chat" | "history" | "requests">("chat");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [requests, setRequests] = useState<HelpRequest[]>([]);
  const [requestsLoading, setRequestsLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [historyLoaded, setHistoryLoaded] = useState(false);

  // Archive & search state
  const [archivedConvos, setArchivedConvos] = useState<ConversationSummary[]>([]);
  const [searchResults, setSearchResults] = useState<ConversationSummary[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [historyMode, setHistoryMode] = useState<"archived" | "search">("archived");

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const pathname = usePathname();

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Load conversation history when widget opens
  const loadConversation = useCallback(async () => {
    if (historyLoaded || !userId) return;
    try {
      const res = await fetch("/api/help-chat/conversations");
      if (res.ok) {
        const data = await res.json();
        if (data.conversation) {
          setConversationId(data.conversation.id);
          setMessages(
            data.conversation.messages.map((m: any) => ({
              role: m.role,
              content: m.content,
            }))
          );
        }
      }
    } catch (e) {
      console.error("[HelpChat] Failed to load conversation:", e);
    } finally {
      setHistoryLoaded(true);
    }
  }, [historyLoaded, userId]);

  useEffect(() => {
    if (open && tab === "chat") loadConversation();
  }, [open, tab, loadConversation]);

  // Load request history when admin opens requests tab
  const loadHistory = useCallback(async () => {
    if (!effectiveIsAdmin) return;
    setRequestsLoading(true);
    try {
      const res = await fetch("/api/help-chat/history");
      if (res.ok) {
        const data = await res.json();
        setRequests(data.requests || []);
      }
    } catch (e) {
      console.error("[HelpChat] Failed to load chat history:", e);
      setHistoryError("Failed to load chat history");
    } finally {
      setRequestsLoading(false);
    }
  }, [effectiveIsAdmin]);

  useEffect(() => {
    if (tab === "requests" && open) loadHistory();
  }, [tab, open, loadHistory]);

  // Load archived conversations
  const loadArchived = useCallback(async () => {
    setArchiveLoading(true);
    try {
      const res = await fetch("/api/help-chat/conversations?mode=archived");
      if (res.ok) {
        const data = await res.json();
        setArchivedConvos(data.conversations || []);
      }
    } catch (e) {
      console.error("[HelpChat] Failed to load archived:", e);
    } finally {
      setArchiveLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === "history" && open) loadArchived();
  }, [tab, open, loadArchived]);

  async function searchConversations() {
    if (!searchQuery.trim()) return;
    setArchiveLoading(true);
    try {
      const res = await fetch(
        `/api/help-chat/conversations?mode=search&q=${encodeURIComponent(searchQuery)}`
      );
      if (res.ok) {
        const data = await res.json();
        setSearchResults(data.conversations || []);
        setHistoryMode("search");
      }
    } catch (e) {
      console.error("[HelpChat] Search failed:", e);
    } finally {
      setArchiveLoading(false);
    }
  }

  async function restoreConversation(convoId: string) {
    try {
      const res = await fetch("/api/help-chat/conversations", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: convoId, action: "restore" }),
      });
      if (res.ok) {
        // Load the restored conversation into chat
        setConversationId(convoId);
        setHistoryLoaded(false);
        setTab("chat");
        // Reload conversation
        const convoRes = await fetch("/api/help-chat/conversations");
        if (convoRes.ok) {
          const data = await convoRes.json();
          if (data.conversation) {
            setConversationId(data.conversation.id);
            setMessages(
              data.conversation.messages.map((m: any) => ({
                role: m.role,
                content: m.content,
              }))
            );
          }
        }
        setHistoryLoaded(true);
      }
    } catch (e) {
      console.error("[HelpChat] Restore failed:", e);
    }
  }

  async function archiveCurrentConversation() {
    if (!conversationId) return;
    try {
      await fetch("/api/help-chat/conversations", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId,
          action: "archive",
        }),
      });
      startNewChat();
    } catch (e) {
      console.error("[HelpChat] Archive failed:", e);
    }
  }

  function startNewChat() {
    setMessages([]);
    setConversationId(null);
  }

  async function sendMessage() {
    if (!input.trim() || loading) return;

    const userMsg: Message = { role: "user", content: input.trim() };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/help-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: userMsg.content,
          currentPage: pathname,
          userId: userId || "anonymous",
          userRole: effectiveRole,
          conversationId,
        }),
      });

      if (!res.ok) throw new Error("Failed");

      const data = await res.json();

      if (data.conversationId) {
        setConversationId(data.conversationId);
      }

      const assistantMsg: Message = {
        role: "assistant",
        content: data.answer,
      };

      if (data.type === "feature_request") {
        assistantMsg.featureRequest = {
          title: data.title,
          description: data.description,
        };
      }

      setMessages((prev) => [...prev, assistantMsg]);
    } catch (e: any) {
      const errMsg = e?.message || "Unknown error";
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `Error: ${errMsg}. Please try again.`,
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  async function submitFeatureRequest(title: string, description: string) {
    try {
      const res = await fetch("/api/help-chat/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          description,
          userId: userId || "anonymous",
          currentPage: pathname,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        const ghLink = data.githubIssue
          ? `\n\nGitHub Issue #${data.githubIssue.number} created — your team will be notified automatically.`
          : "";
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: `Feature request "${title}" has been submitted successfully.${ghLink}`,
          },
        ]);
      }
    } catch (e: any) {
      const reason = e?.message || "Unknown error";
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `Failed to submit feature request: ${reason}`,
        },
      ]);
    }
  }

  function getStatusBadge(status: string) {
    const styles: Record<string, string> = {
      open: "bg-slate-100 text-slate-700",
      in_progress: "bg-blue-100 text-blue-700",
      completed: "bg-green-100 text-green-700",
      verified: "bg-green-100 text-green-700",
    };
    return styles[status] || styles.open;
  }

  function timeAgo(dateStr: string) {
    const diff = Date.now() - new Date(dateStr).getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    if (days === 0) return "Today";
    if (days === 1) return "Yesterday";
    if (days < 7) return `${days}d ago`;
    if (days < 30) return `${Math.floor(days / 7)}w ago`;
    return `${Math.floor(days / 30)}mo ago`;
  }

  if (!loaded) return null;

  const displayedConvos = historyMode === "search" ? searchResults : archivedConvos;

  return (
    <>
      {/* Floating chat bubble */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full shadow-lg flex items-center justify-center text-white hover:scale-105 transition-transform"
          style={{ backgroundColor: "#4c9a2a" }}
          aria-label="Open help chat"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        </button>
      )}

      {/* Chat panel */}
      {open && (
        <div className="fixed bottom-6 right-6 z-50 w-[370px] h-[520px] flex flex-col hui-card shadow-xl rounded-xl overflow-hidden border border-hui-border">
          {/* Header */}
          <div
            className="flex items-center justify-between px-4 py-3 text-white"
            style={{ backgroundColor: "#4c9a2a" }}
          >
            <span className="text-sm font-semibold">ProBuild Help</span>
            <div className="flex items-center gap-1.5">
              {/* Tab buttons */}
              <div className="flex bg-white/20 rounded text-xs">
                <button
                  onClick={() => setTab("chat")}
                  className={`px-2 py-1 rounded ${tab === "chat" ? "bg-white/30 font-medium" : ""}`}
                >
                  Chat
                </button>
                <button
                  onClick={() => { setTab("history"); setHistoryMode("archived"); }}
                  className={`px-2 py-1 rounded ${tab === "history" ? "bg-white/30 font-medium" : ""}`}
                >
                  History
                </button>
                {effectiveIsAdmin && (
                  <button
                    onClick={() => setTab("requests")}
                    className={`px-2 py-1 rounded ${tab === "requests" ? "bg-white/30 font-medium" : ""}`}
                  >
                    Requests
                  </button>
                )}
              </div>
              {/* New Chat */}
              <button
                onClick={startNewChat}
                className="text-white/80 hover:text-white ml-1"
                aria-label="New conversation"
                title="New conversation"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                </svg>
              </button>
              {/* Close */}
              <button
                onClick={() => setOpen(false)}
                className="text-white/80 hover:text-white"
                aria-label="Close help chat"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          </div>

          {/* ── Chat tab ────────────────────────────────────────── */}
          {tab === "chat" && (
            <>
              <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 bg-hui-background">
                {messages.length === 0 && (
                  <div className="text-center text-sm text-hui-textMuted mt-8">
                    <p className="font-medium text-hui-textMain mb-1">
                      Hi! How can I help?
                    </p>
                    <p>Ask me anything about using ProBuild.</p>
                  </div>
                )}
                {messages.map((msg, i) => (
                  <div
                    key={i}
                    className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                  >
                    <div
                      className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                        msg.role === "user"
                          ? "text-white"
                          : "bg-white border border-hui-border text-hui-textMain"
                      }`}
                      style={
                        msg.role === "user"
                          ? { backgroundColor: "#4c9a2a" }
                          : undefined
                      }
                    >
                      <p className="whitespace-pre-wrap">{msg.content}</p>
                      {msg.featureRequest && effectiveIsAdmin && (
                        <button
                          onClick={() =>
                            submitFeatureRequest(
                              msg.featureRequest!.title,
                              msg.featureRequest!.description
                            )
                          }
                          className="mt-2 text-xs hui-btn-green px-2 py-1 rounded"
                        >
                          Submit as feature request?
                        </button>
                      )}
                    </div>
                  </div>
                ))}
                {loading && (
                  <div className="flex justify-start">
                    <div className="bg-white border border-hui-border rounded-lg px-3 py-2 text-sm text-hui-textMuted">
                      Thinking...
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>

              {/* Input + archive button */}
              <div className="border-t border-hui-border px-3 py-2 bg-white">
                {conversationId && messages.length > 0 && (
                  <div className="flex justify-end mb-1">
                    <button
                      onClick={archiveCurrentConversation}
                      className="text-[10px] text-hui-textMuted hover:text-red-500 transition"
                    >
                      Archive this chat
                    </button>
                  </div>
                )}
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && sendMessage()}
                    placeholder="Ask a question..."
                    className="hui-input flex-1 text-sm"
                    disabled={loading}
                  />
                  <button
                    onClick={sendMessage}
                    disabled={loading || !input.trim()}
                    className="hui-btn-green px-3 py-1.5 rounded text-sm disabled:opacity-50"
                  >
                    Send
                  </button>
                </div>
              </div>
            </>
          )}

          {/* ── History tab (archived + search) ──────────────────── */}
          {tab === "history" && (
            <div className="flex-1 overflow-y-auto bg-hui-background flex flex-col">
              {/* Search bar */}
              <div className="px-3 py-2 border-b border-hui-border bg-white">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && searchConversations()}
                    placeholder="Search conversations..."
                    className="hui-input flex-1 text-sm"
                  />
                  <button
                    onClick={searchConversations}
                    disabled={!searchQuery.trim()}
                    className="hui-btn-green px-2.5 py-1 rounded text-xs disabled:opacity-50"
                  >
                    Search
                  </button>
                </div>
                {historyMode === "search" && (
                  <button
                    onClick={() => { setHistoryMode("archived"); setSearchResults([]); setSearchQuery(""); }}
                    className="text-xs text-hui-primary mt-1.5 hover:underline"
                  >
                    Back to archived
                  </button>
                )}
              </div>

              {/* List */}
              <div className="flex-1 overflow-y-auto px-3 py-2">
                {archiveLoading ? (
                  <p className="text-sm text-hui-textMuted text-center mt-8">Loading...</p>
                ) : displayedConvos.length === 0 ? (
                  <div className="text-center text-sm text-hui-textMuted mt-8">
                    <p className="font-medium text-hui-textMain mb-1">
                      {historyMode === "search" ? "No matches" : "No archived chats"}
                    </p>
                    <p>
                      {historyMode === "search"
                        ? "Try a different search term."
                        : "Chats auto-archive after 7 days of inactivity."}
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {displayedConvos.map((c) => (
                      <div
                        key={c.id}
                        className="bg-white border border-hui-border rounded-lg p-3 hover:shadow-sm transition"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-sm font-medium text-hui-textMain truncate flex-1">
                            {c.title || "Untitled chat"}
                          </p>
                          <span className="text-[10px] text-hui-textMuted whitespace-nowrap">
                            {timeAgo(c.updatedAt)}
                          </span>
                        </div>
                        {c.matchPreview && (
                          <p className="text-xs text-hui-textMuted mt-1 truncate">
                            ...{c.matchPreview}...
                          </p>
                        )}
                        <div className="flex items-center justify-between mt-2">
                          <span className="text-[10px] text-hui-textMuted">
                            {c.messageCount} messages
                          </span>
                          <button
                            onClick={() => restoreConversation(c.id)}
                            className="text-xs text-hui-primary hover:underline font-medium"
                          >
                            Restore
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Requests tab (admin only) ────────────────────────── */}
          {tab === "requests" && effectiveIsAdmin && (
            <div className="flex-1 overflow-y-auto px-4 py-3 bg-hui-background">
              {historyError ? (
                <p className="text-sm text-red-500 text-center mt-8">
                  {historyError}
                </p>
              ) : requestsLoading ? (
                <p className="text-sm text-hui-textMuted text-center mt-8">
                  Loading...
                </p>
              ) : requests.length === 0 ? (
                <div className="text-center text-sm text-hui-textMuted mt-8">
                  <p className="font-medium text-hui-textMain mb-1">
                    No requests yet
                  </p>
                  <p>Feature requests you submit will appear here.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {requests.map((r) => (
                    <div
                      key={r.id}
                      className="bg-white border border-hui-border rounded-lg p-3"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-medium text-hui-textMain">
                          {r.question}
                        </p>
                        <span
                          className={`text-xs px-2 py-0.5 rounded-full whitespace-nowrap ${getStatusBadge(r.status)}`}
                        >
                          {r.status.replace("_", " ")}
                        </span>
                      </div>
                      {r.response && (
                        <p className="text-xs text-hui-textMuted mt-1">
                          {r.response}
                        </p>
                      )}
                      <p className="text-xs text-hui-textMuted mt-1">
                        {new Date(r.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}
