"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import DOMPurify from "dompurify";
import Avatar from "@/components/Avatar";
import { updateLead } from "@/lib/actions";
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';

interface LeadMessageData {
    id: string;
    direction: string;
    senderName: string;
    senderEmail?: string;
    subject?: string;
    body: string;
    channel: string;
    attachments?: string;
    sentViaEmail: boolean;
    sentViaSms: boolean;
    createdAt: string;
}

interface EstimateOption {
    id: string;
    code: string;
    title: string;
    status: string;
}

interface LeadMessagingProps {
    leadId: string;
    clientName: string;
    leadName: string;
    leadSource: string | null;
    createdAt: string;
    location: string | null;
    clientEmail: string | null;
    clientPhone: string | null;
    initialMessage: string | null;
    estimates: EstimateOption[];
}

export default function LeadMessaging({
    leadId, clientName, leadName, leadSource, createdAt, location, clientEmail, clientPhone,
    initialMessage, estimates,
}: LeadMessagingProps) {
    const [messages, setMessages] = useState<LeadMessageData[]>([]);
    const [messageText, setMessageText] = useState("");
    const [sendMode, setSendMode] = useState<"email" | "sms" | "both">("email");
    const [sending, setSending] = useState(false);
    const [loading, setLoading] = useState(true);
    const [attachedEstimates, setAttachedEstimates] = useState<EstimateOption[]>([]);
    const [showEstimatePicker, setShowEstimatePicker] = useState(false);
    const [aiSuggesting, setAiSuggesting] = useState(false);
    const [showAiMenu, setShowAiMenu] = useState(false);
    
    // Advanced Messaging States
    const [teamMembers, setTeamMembers] = useState<{id: string, name: string, email: string}[]>([]);
    const [ccEmails, setCcEmails] = useState<string[]>([]);
    const [scheduledForDate, setScheduledForDate] = useState("");
    const [showPreview, setShowPreview] = useState(false);
    const [previewMode, setPreviewMode] = useState<"desktop" | "mobile">("desktop");
    const [showCcDropdown, setShowCcDropdown] = useState(false);
    const [customCcInput, setCustomCcInput] = useState("");

    const router = useRouter();
    const [nameValue, setNameValue] = useState(leadName);
    const [savedName, setSavedName] = useState(leadName);
    const savingRef = useRef(false);
    const isEditingRef = useRef(false);

    useEffect(() => {
        if (!isEditingRef.current) {
            setNameValue(leadName);
            setSavedName(leadName);
        }
    }, [leadName]);

    async function saveLeadName() {
        isEditingRef.current = false;
        const trimmed = nameValue.trim();
        if (savingRef.current) return;
        if (!trimmed || trimmed === savedName) {
            setNameValue(savedName);
            return;
        }
        savingRef.current = true;
        try {
            await updateLead(leadId, { name: trimmed });
            setSavedName(trimmed);
            toast.success("Lead renamed");
            router.refresh();
        } catch (e: any) {
            setNameValue(savedName);
            toast.error(e?.message || "Failed to rename lead");
        } finally {
            savingRef.current = false;
        }
    }

    const scrollRef = useRef<HTMLDivElement>(null);
    const pollRef = useRef<NodeJS.Timeout | null>(null);
    const aiMenuRef = useRef<HTMLDivElement>(null);
    const estimatePickerRef = useRef<HTMLDivElement>(null);

    const editor = useEditor({
        extensions: [
            StarterKit,
            Link.configure({
                openOnClick: false,
                HTMLAttributes: {
                    class: 'text-indigo-600 underline cursor-pointer',
                },
            }),
        ],
        content: messageText || "",
        immediatelyRender: false,
        onUpdate: ({ editor }) => {
            setMessageText(editor.getHTML());
        },
        editorProps: {
            attributes: {
                class: 'min-h-[120px] max-h-[250px] overflow-y-auto resize-none text-sm text-hui-textMain focus:outline-none bg-transparent prose prose-sm prose-slate max-w-none px-3 py-2',
            },
        },
    });

    const createdDate = new Date(createdAt);
    const daysSince = Math.floor((Date.now() - createdDate.getTime()) / (1000 * 60 * 60 * 24));
    const formattedDate = createdDate.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    const formattedTime = createdDate.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });

    const fetchMessages = useCallback(async () => {
        try {
            const res = await fetch(`/api/leads/messages?leadId=${leadId}`);
            if (!res.ok) return;
            const data = await res.json();
            setMessages(data.messages || []);
        } catch {} finally {
            setLoading(false);
        }
    }, [leadId]);

    const fetchTeamMembers = useCallback(async () => {
        try {
            const res = await fetch('/api/users');
            if (res.ok) {
                const data = await res.json();
                setTeamMembers(Array.isArray(data) ? data : []);
            }
        } catch {}
    }, []);

    useEffect(() => {
        fetchMessages();
        fetchTeamMembers();
        pollRef.current = setInterval(fetchMessages, 10000);
        return () => { if (pollRef.current) clearInterval(pollRef.current); };
    }, [fetchMessages]);

    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [messages]);

    // Close menus on outside click
    useEffect(() => {
        function handleClick(e: MouseEvent) {
            if (aiMenuRef.current && !aiMenuRef.current.contains(e.target as Node)) setShowAiMenu(false);
            if (estimatePickerRef.current && !estimatePickerRef.current.contains(e.target as Node)) setShowEstimatePicker(false);
            const target = e.target as HTMLElement;
            if (!target.closest('.cc-dropdown-container')) setShowCcDropdown(false);
        }
        document.addEventListener("mousedown", handleClick);
        return () => document.removeEventListener("mousedown", handleClick);
    }, []);

    const handleSend = async () => {
        const text = messageText.trim();
        if (!text || sending) return;
        setSending(true);
        try {
            const res = await fetch("/api/leads/messages", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    leadId,
                    body: text,
                    subject: `Message from Golden Touch Remodeling LLC about ${clientName}'s project`,
                    channel: sendMode,
                    attachments: attachedEstimates.map(e => ({ type: "estimate", id: e.id, name: e.code })),
                    scheduledFor: scheduledForDate ? new Date(scheduledForDate).toISOString() : undefined,
                    ccEmails: Array.from(new Set([...ccEmails, ...customCcInput.split(",").map(x => x.trim()).filter(Boolean)])),
                }),
            });
            if (res.ok) {
                const msg = await res.json();
                setMessages(prev => [...prev, msg]);
                setMessageText("");
                setAttachedEstimates([]);
                setScheduledForDate("");
                setCcEmails([]);
                setCustomCcInput("");
                editor?.commands.setContent("");
            } else {
                const errData = await res.json().catch(() => ({}));
                console.error("[Send] API error:", res.status, errData);
                alert(`Failed to send: ${errData?.error || res.statusText}`);
            }
        } catch (err) {
            console.error("[Send] Network error:", err);
            alert("Failed to send message. Check your connection.");
        } finally {
            setSending(false);
        }
    };

    const handleAiSuggest = async (context: string) => {
        setShowAiMenu(false);
        setAiSuggesting(true);
        try {
            const res = await fetch("/api/client-messages/suggest", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ leadId, context }),
            });
            if (res.ok) {
                const data = await res.json();
                if (data.suggestion) {
                    setMessageText(data.suggestion);
                    editor?.commands.setContent(data.suggestion);
                }
            } else {
                const errData = await res.json().catch(() => ({}));
                console.error("[AI Suggest] API error:", res.status, errData);
                alert(`AI suggestion failed: ${errData?.error || res.statusText}`);
            }
        } catch (err) {
            console.error("[AI Suggest] Network error:", err);
            alert("AI suggestion failed. Check your connection.");
        } finally {
            setAiSuggesting(false);
        }
    };

    const toggleEstimate = (est: EstimateOption) => {
        setAttachedEstimates(prev => {
            const exists = prev.find(e => e.id === est.id);
            if (exists) return prev.filter(e => e.id !== est.id);
            return [...prev, est];
        });
    };

    const formatMsgTime = (dateStr: string) => {
        const d = new Date(dateStr);
        return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
    };

    const formatMsgDate = (dateStr: string) => {
        const d = new Date(dateStr);
        return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    };

    const parseAttachments = (json: string | null | undefined) => {
        if (!json) return [];
        try { return JSON.parse(json); } catch { return []; }
    };

    const statusColor = (status: string) => {
        switch (status) {
            case "Approved": return "bg-green-100 text-green-700";
            case "Sent": return "bg-blue-100 text-blue-700";
            case "Draft": return "bg-slate-100 text-slate-600";
            default: return "bg-slate-100 text-slate-600";
        }
    };

    return (
        <div className="flex-1 flex flex-col bg-white min-w-0">
            {/* Header Bar */}
            <div className="px-5 py-3.5 border-b border-hui-border flex items-center justify-between bg-white sticky top-0 z-10">
                <div className="flex items-center gap-3 min-w-0 flex-1">
                    <Avatar name={clientName} color="blue" />
                    <div className="min-w-0 flex-1 group">
                        <div className="flex items-center gap-1.5 min-w-0">
                            <input
                                type="text"
                                value={nameValue}
                                onChange={e => setNameValue(e.target.value)}
                                onFocus={e => { isEditingRef.current = true; e.currentTarget.select(); }}
                                onBlur={saveLeadName}
                                onKeyDown={e => {
                                    if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
                                    if (e.key === "Escape") {
                                        e.preventDefault();
                                        setNameValue(savedName);
                                        isEditingRef.current = false;
                                        (e.target as HTMLInputElement).blur();
                                    }
                                }}
                                aria-label="Lead name"
                                title="Click to rename"
                                className="text-lg font-bold text-hui-textMain bg-transparent border-none outline-none min-w-0 flex-1 max-w-full hover:bg-slate-50 focus:bg-slate-50 rounded px-1 -ml-1 transition cursor-text"
                            />
                            <svg
                                className="w-3.5 h-3.5 text-hui-textMuted opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition shrink-0"
                                viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                                aria-hidden="true"
                            >
                                <path d="M12 20h9" />
                                <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                            </svg>
                        </div>
                        <p className="text-xs text-hui-textMuted px-1 -ml-1">{clientName}</p>
                    </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    <button className="ml-2 px-4 py-1.5 bg-green-600 hover:bg-green-700 text-white text-sm font-semibold rounded-md transition shadow-sm flex items-center gap-1.5">
                        New
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M6 9l6 6 6-6"/></svg>
                    </button>
                </div>
            </div>

            {/* Message Thread */}
            <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-6 bg-slate-50/50">
                {/* Date divider */}
                <div className="text-center text-xs text-slate-400 mb-6 font-medium">{formattedDate}</div>

                {/* Initial inquiry message (if any) */}
                {initialMessage && (
                    <div className="flex gap-4 max-w-3xl mx-auto mb-6">
                        <div className="flex-shrink-0 mt-1">
                            <Avatar name={clientName} color="blue" />
                        </div>
                        <div className="flex-1 min-w-0">
                            <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
                                <div className="space-y-2 text-sm text-slate-700 leading-relaxed">
                                    <p className="font-semibold text-slate-900">Contact Name</p>
                                    <p>{clientName}</p>
                                    {location && (
                                        <>
                                            <p className="font-semibold text-slate-900 mt-3">Project Location</p>
                                            <p>{location}</p>
                                        </>
                                    )}
                                    <p className="font-semibold text-slate-900 mt-3">Message</p>
                                    <p className="text-slate-600 leading-relaxed whitespace-pre-wrap">{initialMessage}</p>
                                </div>
                            </div>
                            <div className="flex items-center gap-2 mt-2 text-xs text-slate-400 justify-end">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
                                Email {formattedTime}
                            </div>
                        </div>
                    </div>
                )}

                {/* Source info */}
                {initialMessage && (
                    <div className="text-center text-xs text-slate-400 mt-2 mb-6 font-medium">
                        Lead received from {leadSource || "Unknown Source"} {formattedTime}
                    </div>
                )}

                {/* Real messages */}
                {loading ? (
                    <div className="flex justify-center py-8">
                        <div className="w-6 h-6 border-2 border-green-600 border-t-transparent rounded-full animate-spin" />
                    </div>
                ) : (
                    messages.map((msg, idx) => {
                        const isOutbound = msg.direction === "OUTBOUND";
                        const showDate = idx === 0 ||
                            formatMsgDate(msg.createdAt) !== formatMsgDate(messages[idx - 1].createdAt);
                        const atts = parseAttachments(msg.attachments);

                        return (
                            <div key={msg.id}>
                                {showDate && (
                                    <div className="text-center text-xs text-slate-400 my-4 font-medium">{formatMsgDate(msg.createdAt)}</div>
                                )}
                                <div className={`flex gap-3 max-w-3xl mx-auto mb-4 ${isOutbound ? "justify-end" : ""}`}>
                                    {!isOutbound && (
                                        <div className="flex-shrink-0 mt-1">
                                            <Avatar name={msg.senderName} color="blue" />
                                        </div>
                                    )}
                                    <div className={`max-w-[70%] ${isOutbound ? "items-end" : ""}`}>
                                        {!isOutbound && (
                                            <p className="text-[10px] font-semibold text-slate-500 mb-1 ml-1">{msg.senderName}</p>
                                        )}
                                        <div className={`px-4 py-3 rounded-2xl text-sm leading-relaxed shadow-sm ${
                                            isOutbound
                                                ? "bg-green-600 text-white rounded-br-md prose-invert prose-a:text-green-200"
                                                : "bg-white text-hui-textMain border border-slate-200 rounded-bl-md"
                                        }`}>
                                            <div className="whitespace-pre-wrap prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(msg.body ?? "") }} />

                                            {/* Attachment chips */}
                                            {atts.length > 0 && (
                                                <div className="mt-2 pt-2 border-t border-white/20 flex flex-wrap gap-2">
                                                    {atts.map((a: any, i: number) => (
                                                        <span key={i} className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-lg ${
                                                            isOutbound ? "bg-green-700/50 text-green-50" : "bg-slate-100 text-slate-700"
                                                        }`}>
                                                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/></svg>
                                                            {a.name}
                                                        </span>
                                                    ))}
                                                </div>
                                            )}
                                        </div>

                                        {/* Delivery info */}
                                        <div className={`flex items-center gap-2 mt-1 text-[10px] text-slate-400 ${isOutbound ? "justify-end" : ""}`}>
                                            {msg.sentViaEmail && (
                                                <span className="flex items-center gap-0.5">
                                                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
                                                    Email
                                                </span>
                                            )}
                                            {msg.sentViaSms && (
                                                <span className="flex items-center gap-0.5">
                                                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
                                                    SMS
                                                </span>
                                            )}
                                            <span>{formatMsgTime(msg.createdAt)}</span>
                                        </div>
                                    </div>
                                    {isOutbound && (
                                        <div className="flex-shrink-0 mt-1">
                                            <div className="w-9 h-9 rounded-full bg-green-600 flex items-center justify-center text-white text-xs font-bold">
                                                {msg.senderName.split(" ").map(n => n[0]).join("").toUpperCase().slice(0, 2)}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>
                        );
                    })
                )}

                {/* No messages + no initial message = empty state */}
                {!loading && messages.length === 0 && !initialMessage && (
                    <div className="flex flex-col items-center justify-center py-16 text-center">
                        <div className="w-16 h-16 bg-slate-100 rounded-2xl flex items-center justify-center mb-4">
                            <svg className="w-8 h-8 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                            </svg>
                        </div>
                        <p className="text-sm font-medium text-hui-textMuted mb-1">No messages yet</p>
                        <p className="text-xs text-slate-400">Send a message to start the conversation with {clientName}</p>
                    </div>
                )}

                {/* Follow-up reminder */}
                {daysSince > 1 && messages.length === 0 && (
                    <div className="max-w-3xl mx-auto mt-8">
                        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex flex-col sm:flex-row items-center justify-between gap-3">
                            <p className="text-sm text-amber-800 font-medium">
                                Last activity was {daysSince} days ago. Follow up?
                            </p>
                            <div className="flex items-center gap-3">
                                <button
                                    onClick={() => handleAiSuggest("followup")}
                                    className="flex items-center gap-2 px-4 py-2 bg-white border border-amber-300 rounded-lg text-sm font-medium text-amber-800 hover:bg-amber-100 transition shadow-sm"
                                >
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
                                    AI Follow-up
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {/* Attached Estimates Bar */}
            {attachedEstimates.length > 0 && (
                <div className="px-5 py-2 bg-green-50 border-t border-green-200 flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-semibold text-green-700">Attachments:</span>
                    {attachedEstimates.map(est => (
                        <span key={est.id} className="inline-flex items-center gap-1.5 bg-white border border-green-300 rounded-full px-3 py-1 text-xs font-medium text-green-800 shadow-sm">
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/></svg>
                            {est.code} — {est.title}
                            <button onClick={() => toggleEstimate(est)} className="ml-0.5 text-green-600 hover:text-red-500 transition">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                            </button>
                        </span>
                    ))}
                </div>
            )}

            {/* Compose Area */}
            <div className="border-t border-hui-border bg-white">
                {/* To / Subject / Cc */}
                <div className="px-5 pt-4">
                    <div className="flex items-center gap-2 text-sm border-b border-slate-100 pb-2 mb-2">
                        <span className="text-slate-500 font-medium w-16">To:</span>
                        <span className="text-hui-textMain font-medium">{clientName}</span>
                    </div>
                    <div className="flex items-center gap-2 text-sm border-b border-slate-100 pb-2 mb-2 relative cc-dropdown-container">
                        <span className="text-slate-500 font-medium w-16">Cc:</span>
                        <div 
                            className="flex-1 min-h-[24px] cursor-text flex items-center flex-wrap gap-1.5"
                            onClick={() => setShowCcDropdown(true)}
                        >
                            {ccEmails.map(email => {
                                const tm = teamMembers.find(t => t.email === email);
                                return (
                                    <span key={email} className="bg-slate-100 text-slate-700 text-xs px-2 py-0.5 rounded-full flex items-center gap-1 border border-slate-200 shadow-sm">
                                        {tm ? tm.name : email}
                                        <button 
                                            type="button"
                                            onClick={(e) => { e.stopPropagation(); setCcEmails(prev => prev.filter(m => m !== email)); }}
                                            className="hover:text-red-500 ml-0.5 translate-y-[0.5px]"
                                        >×</button>
                                    </span>
                                );
                            })}
                            
                            <input 
                                type="text"
                                className="bg-transparent border-none outline-none text-sm placeholder:text-slate-300 flex-1 min-w-[150px] m-0 p-0 shadow-none focus:ring-0"
                                placeholder={ccEmails.length === 0 ? "Select or type emails..." : ""}
                                value={customCcInput}
                                onChange={(e) => setCustomCcInput(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter" && customCcInput.trim()) {
                                        e.preventDefault();
                                        const emails = customCcInput.split(",").map(m => m.trim()).filter(Boolean);
                                        setCcEmails(prev => Array.from(new Set([...prev, ...emails])));
                                        setCustomCcInput("");
                                    } else if (e.key === "Backspace" && customCcInput === "" && ccEmails.length > 0) {
                                        setCcEmails(prev => prev.slice(0, -1));
                                    }
                                }}
                            />
                        </div>
                        {showCcDropdown && (
                            <div className="absolute top-full left-16 mt-1 w-64 bg-white border border-slate-200 rounded-lg shadow-xl z-50 max-h-48 overflow-y-auto pt-1 pb-1">
                                {teamMembers.map(member => (
                                    <label key={member.id} className="flex items-center gap-3 px-3 py-2 hover:bg-slate-50 cursor-pointer transition">
                                        <input 
                                            type="checkbox"
                                            checked={ccEmails.includes(member.email)}
                                            onChange={(e) => {
                                                if (e.target.checked) setCcEmails(prev => [...prev, member.email]);
                                                else setCcEmails(prev => prev.filter(m => m !== member.email));
                                            }}
                                            className="w-3.5 h-3.5 text-green-600 focus:ring-green-500 rounded border-slate-300"
                                        />
                                        <div className="text-sm">
                                            <p className="font-semibold text-hui-textMain leading-none">{member.name}</p>
                                            <p className="text-[10px] text-slate-500 mt-0.5">{member.email}</p>
                                        </div>
                                    </label>
                                ))}
                                {teamMembers.length === 0 && (
                                    <p className="text-xs text-slate-400 p-3 text-center">No team members found.</p>
                                )}
                            </div>
                        )}
                    </div>
                    <div className="flex items-center gap-2 text-sm border-b border-slate-100 pb-2 mb-3">
                        <span className="text-slate-500 font-medium w-16">Subject:</span>
                        <span className="text-hui-textMain text-sm">New message from Golden Touch Remodeling LLC about {clientName}&apos;s project</span>
                    </div>
                </div>

                {/* Text Area (Rich Text Editor) */}
                <div className="px-5">
                    <div className="relative border border-slate-200 rounded-lg bg-white overflow-hidden transition-all focus-within:ring-2 focus-within:ring-green-500 focus-within:border-green-500">
                        {/* WYSIWYG Toolbar */}
                        <div className="bg-slate-50 border-b border-slate-200 px-3 py-1.5 flex items-center gap-1">
                            <button
                                type="button"
                                onClick={(e) => { e.preventDefault(); editor?.chain().focus().toggleBold().run(); }}
                                className={`p-1.5 transition rounded font-bold text-sm leading-none h-7 w-7 flex items-center justify-center ${editor?.isActive('bold') ? 'bg-slate-200 text-slate-800' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-200/50'}`}
                                title="Bold"
                            >
                                B
                            </button>
                            <button
                                type="button"
                                onClick={(e) => { e.preventDefault(); editor?.chain().focus().toggleItalic().run(); }}
                                className={`p-1.5 transition rounded italic text-sm font-serif leading-none h-7 w-7 flex items-center justify-center ${editor?.isActive('italic') ? 'bg-slate-200 text-slate-800' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-200/50'}`}
                                title="Italic"
                            >
                                I
                            </button>
                            <div className="w-px h-4 bg-slate-300 mx-1" />
                            <button
                                type="button"
                                onClick={(e) => {
                                    e.preventDefault();
                                    const url = window.prompt("Enter link URL");
                                    if (url) {
                                        editor?.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
                                    } else if (url === "") {
                                        editor?.chain().focus().unsetLink().run();
                                    }
                                }}
                                className={`transition rounded flex items-center justify-center h-7 w-7 ${editor?.isActive('link') ? 'bg-slate-200 text-slate-800' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-200/50'}`}
                                title="Link"
                            >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>
                            </button>
                        </div>
                        
                        <div className={`${sending ? 'opacity-50 pointer-events-none' : ''}`}>
                            <EditorContent editor={editor} />
                        </div>

                        {aiSuggesting && (
                            <div className="absolute inset-0 flex items-center justify-center bg-white/80 z-10 text-sm text-indigo-600 font-medium pb-8 border-t border-slate-200">
                                <div className="w-4 h-4 mr-2 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
                                Writing with AI...
                            </div>
                        )}
                    </div>
                </div>

                {/* Bottom Toolbar */}
                <div className="px-5 py-3 border-t border-slate-100 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        {/* Send button & Schedule picker */}
                        <div className="flex items-center gap-2">
                            <button
                                onClick={handleSend}
                                disabled={!messageText.trim() || sending}
                                className={`px-5 py-2 text-sm font-semibold rounded-lg transition shadow-sm ${
                                    messageText.trim() && !sending
                                        ? "bg-green-600 hover:bg-green-700 text-white"
                                        : "bg-slate-200 text-slate-400 cursor-not-allowed"
                                }`}
                            >
                                {sending ? "Sending..." : "Send"}
                            </button>
                            <input 
                                type="datetime-local" 
                                value={scheduledForDate}
                                onChange={(e) => setScheduledForDate(e.target.value)}
                                className="text-xs bg-slate-50 border border-slate-200 rounded-lg px-2 py-2 focus:outline-none focus:ring-1 focus:ring-green-500 text-slate-600 h-9"
                                title="Schedule Send (leave blank to send now)"
                            />
                        </div>

                        {/* Email/SMS/Both toggle */}
                        <div className="flex items-center gap-3 px-3">
                            {(["email", "sms", "both"] as const).map(mode => (
                                <label key={mode} className="flex items-center gap-1.5 cursor-pointer">
                                    <input
                                        type="radio"
                                        name="sendMode"
                                        checked={sendMode === mode}
                                        onChange={() => setSendMode(mode)}
                                        className="w-3.5 h-3.5 text-green-600 focus:ring-green-500"
                                    />
                                    <span className={`text-xs font-medium ${sendMode === mode ? "text-hui-textMain" : "text-slate-400"}`}>
                                        {mode === "email" ? "Email" : mode === "sms" ? "SMS Text" : "Both"}
                                    </span>
                                </label>
                            ))}
                        </div>

                        {/* Formatting tools + Attach Estimate */}
                        <div className="flex items-center gap-1 border-l border-slate-200 pl-3">
                            {/* Attach Estimate */}
                            <div className="relative" ref={estimatePickerRef}>
                                <button
                                    onClick={() => setShowEstimatePicker(!showEstimatePicker)}
                                    className={`p-1.5 rounded transition flex items-center gap-1 text-xs font-medium ${
                                        attachedEstimates.length > 0
                                            ? "text-green-700 bg-green-50"
                                            : "text-slate-400 hover:text-slate-600"
                                    }`}
                                    title="Attach Estimate"
                                >
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
                                    {attachedEstimates.length > 0 && (
                                        <span className="bg-green-600 text-white w-4 h-4 rounded-full text-[9px] flex items-center justify-center font-bold">
                                            {attachedEstimates.length}
                                        </span>
                                    )}
                                </button>

                                {showEstimatePicker && (
                                    <div className="absolute bottom-8 left-0 bg-white border border-slate-200 rounded-lg shadow-xl w-72 z-30 py-2">
                                        <p className="px-3 py-1.5 text-[10px] font-bold text-slate-500 uppercase tracking-wider">Attach Estimate</p>
                                        {estimates.length === 0 ? (
                                            <p className="px-3 py-3 text-sm text-slate-400 text-center">No estimates available</p>
                                        ) : (
                                            estimates.map(est => {
                                                const isAttached = attachedEstimates.some(e => e.id === est.id);
                                                return (
                                                    <button
                                                        key={est.id}
                                                        onClick={() => { toggleEstimate(est); }}
                                                        className={`w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-slate-50 transition ${
                                                            isAttached ? "bg-green-50" : ""
                                                        }`}
                                                    >
                                                        <div className="flex items-center gap-2">
                                                            <div className={`w-4 h-4 rounded border-2 flex items-center justify-center transition ${
                                                                isAttached ? "bg-green-600 border-green-600" : "border-slate-300"
                                                            }`}>
                                                                {isAttached && (
                                                                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><polyline points="20,6 9,17 4,12"/></svg>
                                                                )}
                                                            </div>
                                                            <div className="text-left">
                                                                <span className="font-medium text-hui-textMain">{est.code}</span>
                                                                <span className="text-slate-500 ml-1.5">{est.title}</span>
                                                            </div>
                                                        </div>
                                                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${statusColor(est.status)}`}>
                                                            {est.status}
                                                        </span>
                                                    </button>
                                                );
                                            })
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>

                    <div className="flex items-center gap-3">
                        {/* AI Write for Me - with context options */}
                        <div className="relative" ref={aiMenuRef}>
                            <button
                                onClick={() => setShowAiMenu(!showAiMenu)}
                                disabled={aiSuggesting}
                                className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold rounded-lg transition shadow-sm disabled:opacity-60"
                            >
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
                                {aiSuggesting ? "Thinking..." : "Write for Me"}
                                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M6 9l6 6 6-6"/></svg>
                            </button>

                            {showAiMenu && (
                                <div className="absolute bottom-9 right-0 bg-white border border-slate-200 rounded-lg shadow-xl w-56 z-30 py-1.5">
                                    <p className="px-3 py-1 text-[10px] font-bold text-slate-500 uppercase tracking-wider">AI Message Suggestion</p>
                                    {[
                                        { key: "initial", label: "Initial Outreach", icon: "👋" },
                                        { key: "followup", label: "Follow Up", icon: "📩" },
                                        { key: "estimate", label: "Estimate Cover Note", icon: "📋" },
                                        { key: "schedule_update", label: "Schedule Update", icon: "📅" },
                                        { key: "general", label: "General Reply", icon: "💬" },
                                    ].map(opt => (
                                        <button
                                            key={opt.key}
                                            onClick={() => handleAiSuggest(opt.key)}
                                            className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-hui-textMain hover:bg-indigo-50 transition"
                                        >
                                            <span>{opt.icon}</span>
                                            {opt.label}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>

                        <button 
                            onClick={() => setShowPreview(true)}
                            className="text-xs text-slate-500 hover:text-slate-700 transition flex items-center gap-1"
                        >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                            Preview
                        </button>
                    </div>
                </div>
            </div>

            {/* Preview Modal */}
            {showPreview && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4">
                    <div className="bg-white rounded-xl shadow-2xl flex flex-col overflow-hidden max-h-[90vh] max-w-5xl w-full">
                        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50">
                            <h3 className="text-lg font-bold text-slate-800 flex items-center gap-2">
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                                Message Preview
                            </h3>
                            <div className="flex items-center gap-4">
                                <div className="flex items-center bg-slate-200 rounded-lg p-1">
                                    <button 
                                        onClick={() => setPreviewMode("desktop")}
                                        className={`px-3 py-1.5 text-xs font-semibold rounded-md transition ${previewMode === "desktop" ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
                                    >
                                        Desktop
                                    </button>
                                    <button 
                                        onClick={() => setPreviewMode("mobile")}
                                        className={`px-3 py-1.5 text-xs font-semibold rounded-md transition ${previewMode === "mobile" ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
                                    >
                                        Mobile
                                    </button>
                                </div>
                                <button onClick={() => setShowPreview(false)} className="text-slate-400 hover:text-slate-600 transition">
                                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                                </button>
                            </div>
                        </div>
                        <div className="flex-1 overflow-y-auto p-8 flex justify-center bg-slate-100">
                            {/* Email Container Simulation */}
                            <div 
                                className={`bg-white shadow-sm ring-1 ring-slate-200 min-h-[400px] transition-all duration-300 ease-in-out ${previewMode === "desktop" ? "w-full max-w-2xl" : "w-[375px]"}`}
                                style={{ fontFamily: "sans-serif" }}
                            >
                                <div className="p-8">
                                    {/* Email Header */}
                                    <div className="text-center mb-8">
                                        <h1 className="text-2xl font-bold text-slate-900 m-0">Golden Touch Remodeling LLC</h1>
                                    </div>
                                    
                                    {/* Email Body */}
                                    <div className="border border-slate-200 rounded-xl p-8">
                                        <p className="text-slate-600 mb-4 mt-0">From: <strong>Team</strong></p>
                                        
                                        <div className="bg-slate-50 rounded-lg p-4 my-4">
                                            <div 
                                                className="m-0 leading-relaxed text-slate-800 prose prose-sm max-w-none prose-a:text-green-600"
                                                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(messageText || "Your message will appear here...") }}
                                            />
                                        </div>
                                        
                                        {/* Estimate Links Preview */}
                                        {attachedEstimates.length > 0 && (
                                            <div className="mt-6 text-center">
                                                {attachedEstimates.map(est => (
                                                    <div key={est.id} className="inline-block bg-green-600 text-white px-6 py-2.5 rounded-lg font-semibold text-sm m-1">
                                                        View Estimate {est.code}
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                    
                                    {/* Email Footer */}
                                    <p className="text-center text-slate-400 text-xs mt-6">
                                        Golden Touch Remodeling LLC • 123 Main St, Anytown WA
                                    </p>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
