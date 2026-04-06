"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { usePathname } from "next/navigation";
import { usePermissions } from "@/components/PermissionsProvider";

interface Message {
  role: "user" | "assistant";
  content: string;
  featureRequest?: { title: string; description: string };
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
  const [tab, setTab] = useState<"chat" | "requests">("chat");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [requests, setRequests] = useState<HelpRequest[]>([]);
  const [requestsLoading, setRequestsLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const pathname = usePathname();

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

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
        }),
      });

      if (!res.ok) throw new Error("Failed");

      const data = await res.json();
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
        { role: "assistant", content: `Failed to submit feature request: ${reason}` },
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

  if (!loaded) return null;

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
        <div className="fixed bottom-6 right-6 z-50 w-[350px] h-[500px] flex flex-col hui-card shadow-xl rounded-xl overflow-hidden border border-hui-border">
          {/* Header */}
          <div
            className="flex items-center justify-between px-4 py-3 text-white"
            style={{ backgroundColor: "#4c9a2a" }}
          >
            <span className="text-sm font-semibold">ProBuild Help</span>
            <div className="flex items-center gap-2">
              {effectiveIsAdmin && (
                <div className="flex bg-white/20 rounded text-xs">
                  <button
                    onClick={() => setTab("chat")}
                    className={`px-2 py-1 rounded ${tab === "chat" ? "bg-white/30 font-medium" : ""}`}
                  >
                    Chat
                  </button>
                  <button
                    onClick={() => setTab("requests")}
                    className={`px-2 py-1 rounded ${tab === "requests" ? "bg-white/30 font-medium" : ""}`}
                  >
                    My Requests
                  </button>
                </div>
              )}
              <button
                onClick={() => setOpen(false)}
                className="text-white/80 hover:text-white"
                aria-label="Close help chat"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          </div>

          {/* Chat tab */}
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
                          ? "bg-hui-primary text-white"
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

              {/* Input */}
              <div className="border-t border-hui-border px-3 py-2 bg-white flex gap-2">
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
            </>
          )}

          {/* Requests tab (admin only) */}
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
