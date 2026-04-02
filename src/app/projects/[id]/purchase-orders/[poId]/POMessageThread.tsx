"use client";

import { useState } from "react";
import { MessageCircle, Send, RefreshCw, Paperclip, Bot } from "lucide-react";

export default function POMessageThread({ poId, messages }: { poId: string, messages: any[] }) {
    const [body, setBody] = useState("");
    const [isSending, setIsSending] = useState(false);

    const [isSyncing, setIsSyncing] = useState(false);

    const handleSync = async () => {
        setIsSyncing(true);
        try {
            const res = await fetch(`/api/projects/${poId}/purchase-orders/${poId}/sync`, { method: "POST" });
            const data = await res.json();
            if (data.success) {
                // To force a refresh of the server component data, simplest way is to reload window
                window.location.reload();
            } else {
                alert("Sync failed: " + (data.error || "Unknown error"));
            }
        } catch (e) {
            console.error(e);
        } finally {
            setIsSyncing(false);
        }
    };

    const handleSend = async () => {
        if (!body.trim()) return;
        setIsSending(true);
        try {
            const res = await fetch(`/api/projects/${poId}/purchase-orders/${poId}/send-message`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ body })
            });
            const data = await res.json();
            if (data.success) {
                setBody("");
                window.location.reload();
            } else {
                alert("Failed to send: " + (data.error || "Unknown error"));
            }
        } catch (e) {
            console.error(e);
            alert("Network error sending message.");
        } finally {
            setIsSending(false);
        }
    };

    return (
        <div className="hui-card shadow-sm border border-hui-border flex flex-col mt-6">
            <div className="px-6 py-4 border-b border-hui-border bg-slate-50 flex items-center justify-between">
                <h3 className="font-bold text-hui-textMain flex items-center gap-2">
                    <MessageCircle className="w-4 h-4 text-violet-500" />
                    Vendor Communication Log (Gmail Sync)
                </h3>
                <button 
                    onClick={handleSync}
                    disabled={isSyncing}
                    className="text-xs text-slate-500 hover:text-hui-primary flex items-center gap-1 bg-white px-2 py-1 rounded border border-slate-200 shadow-sm transition disabled:opacity-50"
                >
                    <RefreshCw className={`w-3 h-3 ${isSyncing ? 'animate-spin' : ''}`} /> {isSyncing ? "Syncing..." : "Sync Now"}
                </button>
            </div>
            
            <div className="p-6 bg-slate-50/30 flex flex-col gap-4 max-h-[500px] overflow-y-auto">
                {!messages || messages.length === 0 ? (
                    <div className="text-center py-8 text-slate-400 italic">
                        No messages yet. Messages sent to or received from the Vendor via email will appear here.
                    </div>
                ) : (
                    messages.map((msg) => {
                        const isTeam = msg.senderType === "TEAM";
                        const isAI = msg.senderType === "AI";
                        
                        return (
                            <div key={msg.id} className={`flex flex-col max-w-[85%] ${isTeam || isAI ? 'self-end' : 'self-start'}`}>
                                <div className={`flex items-end gap-2 mb-1 ${isTeam || isAI ? 'flex-row-reverse' : ''}`}>
                                    <div className={`text-xs font-semibold ${isAI ? 'text-rose-500' : 'text-slate-500'}`}>
                                        {msg.senderName || msg.senderEmail} {isAI && <Bot className="w-3 h-3 inline pb-0.5" />}
                                    </div>
                                    <div className="text-[10px] text-slate-400">
                                        {new Date(msg.createdAt).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                                    </div>
                                </div>
                                
                                <div className={`p-3 rounded-lg shadow-sm border whitespace-pre-wrap text-sm ${
                                    isAI 
                                        ? 'bg-rose-50/80 border-rose-100 text-rose-900 rounded-tr-none'
                                    : isTeam 
                                        ? 'bg-violet-50 border-violet-100 text-violet-900 rounded-tr-none' 
                                        : 'bg-white border-slate-200 text-slate-700 rounded-tl-none'
                                }`}>
                                    {msg.isAttachment && (
                                        <div className="mb-2 p-2 bg-black/5 rounded text-xs flex items-center gap-1 font-medium italic">
                                            <Paperclip className="w-3 h-3" /> Attachment Synced
                                        </div>
                                    )}
                                    {msg.body}
                                </div>
                            </div>
                        );
                    })
                )}
            </div>

            <div className="p-4 border-t border-hui-border bg-white flex gap-2">
                <textarea 
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    placeholder="Type a message to the vendor..."
                    className="hui-input flex-1 min-h-[44px] max-h-32 py-2.5 resize-none font-sans text-sm"
                    onKeyDown={(e) => { if(e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                />
                <button 
                    onClick={handleSend}
                    disabled={isSending || !body.trim()}
                    className="hui-btn h-auto px-4 flex items-center justify-center disabled:opacity-50"
                >
                    <Send className="w-4 h-4" />
                </button>
            </div>
        </div>
    );
}
