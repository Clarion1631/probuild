"use client";

import { useState } from "react";
import Avatar from "@/components/Avatar";

interface LeadMessagingProps {
    leadId: string;
    clientName: string;
    leadName: string;
    leadSource: string | null;
    createdAt: string;
    location: string | null;
    clientEmail: string | null;
}

export default function LeadMessaging({
    leadId, clientName, leadName, leadSource, createdAt, location, clientEmail
}: LeadMessagingProps) {
    const [messageText, setMessageText] = useState("");
    const [sendMode, setSendMode] = useState<"email" | "sms">("email");

    const createdDate = new Date(createdAt);
    const daysSince = Math.floor((Date.now() - createdDate.getTime()) / (1000 * 60 * 60 * 24));
    const formattedDate = createdDate.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    const formattedTime = createdDate.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });

    return (
        <div className="flex-1 flex flex-col bg-white min-w-0">
            {/* Header Bar */}
            <div className="px-5 py-3.5 border-b border-hui-border flex items-center justify-between bg-white sticky top-0 z-10">
                <div className="flex items-center gap-3">
                    <Avatar name={clientName} color="blue" />
                    <h2 className="text-lg font-bold text-hui-textMain">{clientName}</h2>
                </div>
                <div className="flex items-center gap-2">
                    {/* Action icons */}
                    <button className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-md transition" title="Edit">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    </button>
                    <button className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-md transition" title="Open in new window">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15,3 21,3 21,9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                    </button>
                    <button className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-md transition" title="Copy">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
                    </button>
                    <button className="ml-2 px-4 py-1.5 bg-green-600 hover:bg-green-700 text-white text-sm font-semibold rounded-md transition shadow-sm flex items-center gap-1.5">
                        New
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M6 9l6 6 6-6"/></svg>
                    </button>
                </div>
            </div>

            {/* Message Thread */}
            <div className="flex-1 overflow-y-auto px-6 py-6 bg-slate-50/50">
                {/* Date divider */}
                <div className="text-center text-xs text-slate-400 mb-6 font-medium">{formattedDate}</div>

                {/* Lead Message Card */}
                <div className="flex gap-4 max-w-3xl mx-auto">
                    <div className="flex-shrink-0 mt-1">
                        <Avatar name={clientName} color="blue" />
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
                            <div className="space-y-2 text-sm text-slate-700 leading-relaxed">
                                <p className="font-semibold text-slate-900">Contact Name</p>
                                <p>{clientName}</p>
                                <p className="font-semibold text-slate-900 mt-3">Project Location</p>
                                <p>{location || "Not specified"}</p>
                                <p className="font-semibold text-slate-900 mt-3">Message</p>
                                <p className="text-slate-600 leading-relaxed">
                                    Hi there,<br /><br />
                                    I have a piece of land where I would like to build a new home, and I also have another property where I&apos;m planning a full house remodel. I&apos;m interested in scheduling a consultation to discuss both projects. I already have some initial sketches, but I&apos;m open to new ideas and professional recommendations.
                                    <br /><br />
                                    Could someone from your team please contact me to discuss the next steps? I can be reached at {clientEmail || "email not provided"}.
                                </p>
                            </div>
                        </div>
                        <div className="flex items-center gap-2 mt-2 text-xs text-slate-400 justify-end">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
                            Email {formattedTime}
                        </div>
                    </div>
                </div>

                {/* Source info */}
                <div className="text-center text-xs text-slate-400 mt-6 font-medium">
                    Lead received from {leadSource || "Unknown Source"} {formattedTime}
                </div>

                {/* Follow-up reminder */}
                {daysSince > 1 && (
                    <div className="max-w-3xl mx-auto mt-8">
                        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex flex-col sm:flex-row items-center justify-between gap-3">
                            <p className="text-sm text-amber-800 font-medium">
                                Last message was from {daysSince} days ago. Follow up?
                            </p>
                            <div className="flex items-center gap-3">
                                <button className="flex items-center gap-2 px-4 py-2 bg-white border border-amber-300 rounded-lg text-sm font-medium text-amber-800 hover:bg-amber-100 transition shadow-sm">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12,6 12,12 16,14"/></svg>
                                    Snooze
                                </button>
                                <button className="flex items-center gap-2 px-4 py-2 bg-white border border-amber-300 rounded-lg text-sm font-medium text-amber-800 hover:bg-amber-100 transition shadow-sm">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 12h8"/></svg>
                                    Archive
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {/* Compose Area */}
            <div className="border-t border-hui-border bg-white">
                {/* To / Subject */}
                <div className="px-5 pt-4">
                    <div className="flex items-center gap-2 text-sm border-b border-slate-100 pb-2 mb-2">
                        <span className="text-slate-500 font-medium w-16">To:</span>
                        <span className="text-hui-textMain font-medium">{clientName}</span>
                        <div className="ml-auto flex items-center gap-3 text-xs text-slate-500">
                            <button className="hover:text-slate-700 transition font-medium">Cc</button>
                            <button className="hover:text-slate-700 transition font-medium flex items-center gap-1">
                                Templates
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M6 9l6 6 6-6"/></svg>
                            </button>
                        </div>
                    </div>
                    <div className="flex items-center gap-2 text-sm border-b border-slate-100 pb-2 mb-3">
                        <span className="text-slate-500 font-medium w-16">Subject:</span>
                        <span className="text-hui-textMain text-sm">New message from Golden Touch Remodeling LLC about {clientName}&apos;s project</span>
                    </div>
                </div>

                {/* Quick Response Buttons */}
                <div className="px-5 pb-2 flex items-center gap-2">
                    {["Interested", "Unavailable", "Not a Fit"].map(label => (
                        <button
                            key={label}
                            className="px-4 py-1.5 border border-slate-300 rounded-md text-sm font-medium text-hui-textMain hover:bg-slate-50 hover:border-slate-400 transition"
                        >
                            {label}
                        </button>
                    ))}
                    <button className="px-3 py-1.5 border border-slate-300 rounded-md text-slate-400 hover:text-slate-600 hover:bg-slate-50 transition">
                        <svg width="16" height="4" viewBox="0 0 24 8" fill="currentColor"><circle cx="4" cy="4" r="2"/><circle cx="12" cy="4" r="2"/><circle cx="20" cy="4" r="2"/></svg>
                    </button>
                </div>

                {/* Text Area */}
                <div className="px-5">
                    <div className="relative">
                        <textarea
                            value={messageText}
                            onChange={e => setMessageText(e.target.value)}
                            placeholder="...or write a message"
                            rows={2}
                            className="w-full resize-none text-sm text-hui-textMain placeholder:text-slate-400 focus:outline-none py-2 border-none bg-transparent"
                        />
                    </div>
                </div>

                {/* Bottom Toolbar */}
                <div className="px-5 py-3 border-t border-slate-100 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        {/* Send button */}
                        <div className="flex items-center">
                            <button className="px-5 py-2 bg-green-600 hover:bg-green-700 text-white text-sm font-semibold rounded-l-lg transition shadow-sm">
                                Send
                            </button>
                            <button className="px-2 py-2 bg-green-700 hover:bg-green-800 text-white rounded-r-lg transition border-l border-green-600">
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M6 9l6 6 6-6"/></svg>
                            </button>
                        </div>

                        {/* Email/SMS toggle */}
                        <div className="flex items-center gap-3 px-3">
                            <label className="flex items-center gap-1.5 cursor-pointer">
                                <input
                                    type="radio"
                                    name="sendMode"
                                    checked={sendMode === "email"}
                                    onChange={() => setSendMode("email")}
                                    className="w-3.5 h-3.5 text-green-600 focus:ring-green-500"
                                />
                                <span className="text-xs font-medium text-hui-textMain">Email</span>
                            </label>
                            <label className="flex items-center gap-1.5 cursor-pointer">
                                <input
                                    type="radio"
                                    name="sendMode"
                                    checked={sendMode === "sms"}
                                    onChange={() => setSendMode("sms")}
                                    className="w-3.5 h-3.5 text-green-600 focus:ring-green-500"
                                />
                                <span className="text-xs font-medium text-slate-400">SMS Text</span>
                            </label>
                        </div>

                        {/* Formatting tools */}
                        <div className="flex items-center gap-1 border-l border-slate-200 pl-3">
                            <button className="p-1.5 text-slate-400 hover:text-slate-600 transition rounded" title="Attach">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
                            </button>
                            <button className="p-1.5 text-slate-400 hover:text-slate-600 transition rounded font-bold text-sm" title="Bold">
                                T
                            </button>
                            <button className="p-1.5 text-slate-400 hover:text-slate-600 transition rounded" title="Link">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>
                            </button>
                            <button className="p-1.5 text-slate-400 hover:text-slate-600 transition rounded" title="Save as template">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><polyline points="17,21 17,13 7,13 7,21"/><polyline points="7,3 7,8 15,8"/></svg>
                            </button>
                        </div>
                    </div>

                    <div className="flex items-center gap-3">
                        {/* Write for Me */}
                        <button className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold rounded-lg transition shadow-sm">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
                            Write for Me
                        </button>
                        <button className="text-xs text-slate-500 hover:text-slate-700 transition flex items-center gap-1">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                            Preview
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
