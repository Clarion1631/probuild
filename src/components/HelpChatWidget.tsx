"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { usePathname } from "next/navigation";
import { usePermissions } from "@/components/PermissionsProvider";

interface Message {
  role: "user" | "assistant";
  content: string;
  featureRequest?: { title: string; description: string };
  bugReport?: { title: string; description: string; steps: string };
  activity?: { tool: string; ok: boolean }[];
}

interface ConversationSummary {
  id: string;
  title: string | null;
  updatedAt: string;
  messageCount: number;
  matchPreview?: string;
}

interface HelpRequest {
  id: string;
  type: string;
  question: string;
  response: string | null;
  status: string;
  createdAt: string;
}

export default function HelpChatWidget({ userRole }: { userId?: string; userRole?: string }) {
  const { isAdmin, loaded } = usePermissions();
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
  const [submittingBugFix, setSubmittingBugFix] = useState(false);
  const [submittedBugFixes, setSubmittedBugFixes] = useState<Set<string>>(new Set());

  const [archivedConvos, setArchivedConvos] = useState<ConversationSummary[]>([]);
  const [searchResults, setSearchResults] = useState<ConversationSummary[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [historyMode, setHistoryMode] = useState<"archived" | "search">("archived");

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const pathname = usePathname();

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const apiFetch = async (url: string, options?: RequestInit) => {
    try {
      const res = await fetch(url, options);
      if (!res.ok) throw new Error();
      return await res.json();
    } catch (e) {
      console.error("[HelpChat] API error:", e);
      return null;
    }
  };

  const loadConversation = useCallback(async () => {
    if (historyLoaded) return;
    const data = await apiFetch("/api/help-chat/conversations");
    if (data?.conversation) {
      setConversationId(data.conversation.id);
      setMessages(data.conversation.messages.map((m: any) => ({ role: m.role, content: m.content })));
    }
    setHistoryLoaded(true);
  }, [historyLoaded]);

  useEffect(() => {
    if (open && tab === "chat") loadConversation();
  }, [open, tab, loadConversation]);

  const loadHistory = useCallback(async () => {
    if (!effectiveIsAdmin) return;
    setRequestsLoading(true);
    const data = await apiFetch("/api/help-chat/history");
    if (data) setRequests(data.requests || []);
    else setHistoryError("Failed to load chat history");
    setRequestsLoading(false);
  }, [effectiveIsAdmin]);

  useEffect(() => {
    if (tab === "requests" && open) loadHistory();
  }, [tab, open, loadHistory]);

  const loadArchived = useCallback(async () => {
    setArchiveLoading(true);
    const data = await apiFetch("/api/help-chat/conversations?mode=archived");
    if (data) setArchivedConvos(data.conversations || []);
    setArchiveLoading(false);
  }, []);

  useEffect(() => {
    if (tab === "history" && open) loadArchived();
  }, [tab, open, loadArchived]);

  async function searchConversations() {
    if (!searchQuery.trim()) return;
    setArchiveLoading(true);
    const data = await apiFetch(`/api/help-chat/conversations?mode=search&q=${encodeURIComponent(searchQuery)}`);
    if (data) {
      setSearchResults(data.conversations || []);
      setHistoryMode("search");
    }
    setArchiveLoading(false);
  }

  async function restoreConversation(convoId: string) {
    const res = await apiFetch("/api/help-chat/conversations", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: convoId, action: "restore" }),
    });
    if (res) {
      setConversationId(convoId);
      setHistoryLoaded(false);
      setTab("chat");
      const convoData = await apiFetch("/api/help-chat/conversations");
      if (convoData?.conversation) {
        setConversationId(convoData.conversation.id);
        setMessages(convoData.conversation.messages.map((m: any) => ({ role: m.role, content: m.content })));
      }
      setHistoryLoaded(true);
    }
  }

  async function archiveCurrentConversation() {
    if (!conversationId) return;
    const res = await apiFetch("/api/help-chat/conversations", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId, action: "archive" }),
    });
    if (res) {
      setMessages([]);
      setConversationId(null);
    }
  }

  async function sendMessage() {
    if (!input.trim() || loading) return;
    const userMsg: Message = { role: "user", content: input.trim() };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);

    const data = await apiFetch("/api/help-chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: userMsg.content, currentPage: pathname, conversationId }),
    });

    if (data) {
      if (data.conversationId) setConversationId(data.conversationId);
      const assistantMsg: Message = { role: "assistant", content: data.answer };
      if (data.activity?.length) assistantMsg.activity = data.activity;
      if (data.type === "feature_request" && data.title) {
        assistantMsg.featureRequest = { title: data.title, description: data.description };
      }
      if (data.type === "bug_report" && data.title) {
        assistantMsg.bugReport = { title: data.title, description: data.description, steps: data.steps || "" };
      }
      setMessages((prev) => [...prev, assistantMsg]);
    } else {
      setMessages((prev) => [...prev, { role: "assistant", content: "Error: Failed to submit. Please try again." }]);
    }
    setLoading(false);
  }

  async function submitFeatureRequest(title: string, description: string) {
    const data = await apiFetch("/api/help-chat/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, description, currentPage: pathname, conversationId }),
    });
    if (data) {
      const gh = data.githubIssue ? `\n\nGitHub Issue #${data.githubIssue.number} created.` : "";
      setMessages((prev) => [...prev, { role: "assistant", content: `Feature request "${title}" submitted.${gh}` }]);
    }
  }

  async function submitBugFix(title: string, description: string, steps: string) {
    if (!conversationId || submittingBugFix) return;
    setSubmittingBugFix(true);
    const data = await apiFetch("/api/help-chat/bug-fix", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, description, steps, currentPage: pathname, conversationId }),
    });
    if (data) {
      setSubmittedBugFixes((prev) => new Set(prev).add(title));
      const gh = data.issueNumber ? `\n\nGitHub Issue #${data.issueNumber} created and queued.` : "";
      setMessages((prev) => [...prev, { role: "assistant", content: `Bug fix "${title}" submitted.${gh}` }]);
    }
    setSubmittingBugFix(false);
  }

  const getStatusBadge = (status: string) => {
    const styles: Record<string, string> = {
      open: "bg-slate-100 text-slate-700",
      submitted: "bg-amber-100 text-amber-800",
      in_progress: "bg-blue-100 text-blue-700",
      deployed: "bg-violet-100 text-violet-700",
      completed: "bg-green-100 text-green-700",
      verified: "bg-green-100 text-green-700",
    };
    return styles[status] || styles.open;
  };

  const timeAgo = (dateStr: string) => {
    const days = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
    return days === 0 ? "Today" : days === 1 ? "Yesterday" : days < 7 ? `${days}d ago` : days < 30 ? `${Math.floor(days / 7)}w ago` : `${Math.floor(days / 30)}mo ago`;
  };

  if (!loaded) return null;

  return (
    <>
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full shadow-lg flex items-center justify-center text-white hover:scale-105 transition-transform"
          style={{ backgroundColor: "#4c9a2a" }}
          aria-label="Open help chat"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
        </button>
      )}

      {open && (
        <div className="fixed bottom-6 right-6 z-50 w-[370px] h-[520px] flex flex-col hui-card shadow-xl rounded-xl overflow-hidden border border-hui-border">
          <div className="flex items-center justify-between px-4 py-3 text-white" style={{ backgroundColor: "#4c9a2a" }}>
            <span className="text-sm font-semibold">ProBuild Help</span>
            <div className="flex items-center gap-1.5">
              <div className="flex bg-white/20 rounded text-xs">
                <button onClick={() => setTab("chat")} className={`px-2 py-1 rounded ${tab === "chat" ? "bg-white/30 font-medium" : ""}`}>Chat</button>
                <button onClick={() => { setTab("history"); setHistoryMode("archived"); }} className={`px-2 py-1 rounded ${tab === "history" ? "bg-white/30 font-medium" : ""}`}>History</button>
                {effectiveIsAdmin && <button onClick={() => setTab("requests")} className={`px-2 py-1 rounded ${tab === "requests" ? "bg-white/30 font-medium" : ""}`}>Requests</button>}
              </div>
              <button onClick={() => { setMessages([]); setConversationId(null); }} className="text-white/80 hover:text-white ml-1" title="New conversation" aria-label="New conversation">
                <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" /></svg>
              </button>
              <button onClick={() => setOpen(false)} className="text-white/80 hover:text-white" aria-label="Close help chat">
                <svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            </div>
          </div>

          {tab === "chat" && (
            <>
              <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 bg-hui-background">
                {messages.length === 0 && (
                  <div className="text-center text-sm text-hui-textMuted mt-8">
                    <p className="font-medium text-hui-textMain mb-1">Hi! How can I help?</p>
                    <p>Ask me anything — or ask me to do it, like &quot;build a contract for the Hoppe job&quot;.</p>
                  </div>
                )}
                {messages.map((msg, i) => (
                  <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                    <div className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${msg.role === "user" ? "text-white" : "bg-white border border-hui-border text-hui-textMain"}`} style={msg.role === "user" ? { backgroundColor: "#4c9a2a" } : undefined}>
                      {msg.activity && msg.activity.length > 0 && (
                        <div className="mb-1.5 space-y-0.5">
                          {msg.activity.map((a, ai) => (
                            <p key={ai} className="text-[10px] text-hui-textMuted">
                              {a.ok ? "✓" : "✗"} {a.tool.replace(/_/g, " ")}
                            </p>
                          ))}
                        </div>
                      )}
                      <p className="whitespace-pre-wrap">{msg.content}</p>
                      {msg.featureRequest && effectiveIsAdmin && (
                        <button onClick={() => submitFeatureRequest(msg.featureRequest!.title, msg.featureRequest!.description)} className="mt-2 text-xs hui-btn-green px-2 py-1 rounded">Submit as feature request?</button>
                      )}
                      {msg.bugReport && effectiveIsAdmin && !submittedBugFixes.has(msg.bugReport.title) && (
                        <button onClick={() => submitBugFix(msg.bugReport!.title, msg.bugReport!.description, msg.bugReport!.steps)} disabled={submittingBugFix || !conversationId} className="mt-2 text-xs px-2 py-1 rounded bg-red-600 text-white disabled:opacity-50">Submit as Bug Fix</button>
                      )}
                    </div>
                  </div>
                ))}
                {loading && <div className="flex justify-start"><div className="bg-white border border-hui-border rounded-lg px-3 py-2 text-sm text-hui-textMuted font-medium animate-pulse">Working on it...</div></div>}
                <div ref={messagesEndRef} />
              </div>
              <div className="border-t border-hui-border px-3 py-2 bg-white">
                {conversationId && messages.length > 0 && (
                  <div className="flex justify-end mb-1"><button onClick={archiveCurrentConversation} className="text-[10px] text-hui-textMuted hover:text-red-500 transition">Archive this chat</button></div>
                )}
                <div className="flex gap-2">
                  <input type="text" value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && sendMessage()} placeholder="Ask a question..." className="hui-input flex-1 text-sm" disabled={loading} />
                  <button onClick={sendMessage} disabled={loading || !input.trim()} className="hui-btn-green px-3 py-1.5 rounded text-sm disabled:opacity-50">Send</button>
                </div>
              </div>
            </>
          )}

          {tab === "history" && (
            <div className="flex-1 overflow-y-auto bg-hui-background flex flex-col">
              <div className="px-3 py-2 border-b border-hui-border bg-white flex flex-col gap-1.5">
                <div className="flex gap-2">
                  <input type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && searchConversations()} placeholder="Search conversations..." className="hui-input flex-1 text-sm" />
                  <button onClick={searchConversations} disabled={!searchQuery.trim()} className="hui-btn-green px-2.5 py-1 rounded text-xs disabled:opacity-50">Search</button>
                </div>
                {historyMode === "search" && <button onClick={() => { setHistoryMode("archived"); setSearchResults([]); setSearchQuery(""); }} className="text-xs text-hui-primary text-left hover:underline">Back to archived</button>}
              </div>
              <div className="flex-1 overflow-y-auto px-3 py-2">
                {archiveLoading ? <p className="text-sm text-hui-textMuted text-center mt-8">Loading...</p> : (historyMode === "search" ? searchResults : archivedConvos).length === 0 ? (
                  <div className="text-center text-sm text-hui-textMuted mt-8">
                    <p className="font-medium text-hui-textMain mb-1">{historyMode === "search" ? "No matches" : "No archived chats"}</p>
                    <p>{historyMode === "search" ? "Try a different search term." : "Chats auto-archive after 7 days of inactivity."}</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {(historyMode === "search" ? searchResults : archivedConvos).map((c) => (
                      <div key={c.id} className="bg-white border border-hui-border rounded-lg p-3 hover:shadow-sm transition">
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-sm font-medium text-hui-textMain truncate flex-1">{c.title || "Untitled chat"}</p>
                          <span className="text-[10px] text-hui-textMuted whitespace-nowrap">{timeAgo(c.updatedAt)}</span>
                        </div>
                        {c.matchPreview && <p className="text-xs text-hui-textMuted mt-1 truncate">...{c.matchPreview}...</p>}
                        <div className="flex items-center justify-between mt-2">
                          <span className="text-[10px] text-hui-textMuted">{c.messageCount} messages</span>
                          <button onClick={() => restoreConversation(c.id)} className="text-xs text-hui-primary hover:underline font-medium">Restore</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {tab === "requests" && effectiveIsAdmin && (
            <div className="flex-1 overflow-y-auto px-4 py-3 bg-hui-background">
              {historyError ? <p className="text-sm text-red-500 text-center mt-8">{historyError}</p> : requestsLoading ? <p className="text-sm text-hui-textMuted text-center mt-8">Loading...</p> : requests.length === 0 ? (
                <div className="text-center text-sm text-hui-textMuted mt-8">
                  <p className="font-medium text-hui-textMain mb-1">No requests yet</p>
                  <p>Requests you submit will appear here.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {requests.map((r) => (
                    <div key={r.id} className="bg-white border border-hui-border rounded-lg p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <span className={`inline-flex text-[10px] px-2 py-0.5 rounded-full mb-1 ${r.type === "bug_fix" ? "bg-red-100 text-red-700" : r.type === "feature_request" ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-700"}`}>
                            {r.type === "bug_fix" ? "Bug Fix" : r.type === "feature_request" ? "Feature Request" : r.type.replace(/_/g, " ")}
                          </span>
                          <p className="text-sm font-medium text-hui-textMain">{r.question}</p>
                        </div>
                        <span className={`text-xs px-2 py-0.5 rounded-full whitespace-nowrap ${getStatusBadge(r.status)}`}>{r.status.replace("_", " ")}</span>
                      </div>
                      {r.response && <p className="text-xs text-hui-textMuted mt-1">{r.response}</p>}
                      <p className="text-xs text-hui-textMuted mt-1">{new Date(r.createdAt).toLocaleDateString()}</p>
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
