"use client";

import { useState } from "react";
import { toast } from "sonner";
import MeetingPopover from "./MeetingPopover";

interface LeadSidebarProps {
    leadId: string;
    leadName: string;
    clientName: string;
    onConvert: () => void;
}

export default function LeadSidebar({ leadId, leadName, clientName, onConvert }: LeadSidebarProps) {
    const [showMoreActions, setShowMoreActions] = useState(false);
    const [activeNav, setActiveNav] = useState("overview");

    const navItems = [
        { key: "overview", label: "Overview", href: `/leads/${leadId}`, icon: (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
        )},
        { key: "notes", label: "Notes", icon: (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        )},
        { key: "tasks", label: "Tasks", href: `/leads/${leadId}/tasks`, icon: (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>
        )},
        { key: "meetings", label: "Meetings", href: `/leads/${leadId}/meetings`, icon: (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/><path d="M8 14h.01M12 14h.01M16 14h.01"/></svg>
        )},
        { key: "3d-floor-plans", label: "3D Floor Plans", icon: (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
        )},
        { key: "schedule", label: "Schedule", icon: (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
        )},
        { key: "files", label: "Files & Photos", icon: (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
        ), href: `/leads/${leadId}/files` },
        { key: "takeoff", label: "Takeoff", href: `/leads/${leadId}/takeoffs`, icon: (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
        )},
        { key: "estimates", label: "Estimates", href: `/leads/${leadId}/estimates`, icon: (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>
        )},
        { key: "contracts", label: "Contracts", href: `/leads/${leadId}/contracts`, icon: (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/><path d="M12 18v-6"/><path d="M9 15h6"/></svg>
        )},
    ];

    const quickCreateItems = [
        { label: "Tasks", icon: (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>
        )},
        // Meeting is handled separately via MeetingPopover
        { label: "Contract", icon: (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/></svg>
        )},
        { label: "Estimate", icon: (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>
        )},
        { label: "Schedule", icon: (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/><path d="M8 14h.01M12 14h.01M16 14h.01"/></svg>
        )},
        { label: "3D Floor Plan", icon: (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
        )},
        { label: "Note", icon: (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        )},
        { label: "Call Log", icon: (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"/></svg>
        )},
        { label: "Takeoff", icon: (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
        )},
    ];

    const moreActions = [
        { label: "Print", icon: "🖨️", action: () => toast.info("Print coming soon") },
        { label: "Refer", icon: "✨", action: () => toast.info("Refer coming soon") },
        { label: "Snooze", icon: "⏰", action: () => toast.info("Snooze coming soon") },
        { label: "Archive", icon: "📦", action: () => toast.info("Archive coming soon") },
        { label: "Delete", icon: "🗑️", action: () => toast.info("Delete coming soon"), danger: true },
    ];

    return (
        <div className="w-[220px] flex-shrink-0 border-r border-hui-border bg-white flex flex-col overflow-y-auto">
            {/* Lead Header */}
            <div className="px-4 py-4 border-b border-hui-border">
                <div className="flex items-center gap-2">
                    <div className="text-xs text-hui-textMuted leading-tight">
                        {clientName} sent a
                    </div>
                </div>
                <div className="text-sm font-semibold text-hui-textMain mt-0.5 flex items-center gap-2">
                    Direct Message
                    <button className="text-hui-textMuted hover:text-hui-textMain transition">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    </button>
                </div>
            </div>

            {/* Navigation */}
            <nav className="py-2">
                {navItems.map(item => (
                    <a
                        key={item.key}
                        href={item.href || "#"}
                        onClick={(e) => {
                            if (!item.href) e.preventDefault();
                            setActiveNav(item.key);
                        }}
                        className={`flex items-center gap-3 px-4 py-2 text-sm transition-colors cursor-pointer ${
                            activeNav === item.key
                                ? "text-green-700 font-bold border-l-4 border-green-600 bg-green-50/30"
                                : "text-slate-600 hover:bg-slate-50 border-l-4 border-transparent"
                        }`}
                    >
                        <span className={activeNav === item.key ? "text-green-600" : "text-slate-400"}>{item.icon}</span>
                        {item.label}
                    </a>
                ))}
            </nav>

            {/* Quick Create */}
            <div className="px-4 py-3 border-t border-hui-border">
                <p className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider mb-3">Quick Create</p>
                <div className="grid grid-cols-3 gap-2">
                    {/* Meeting popover (special handling) */}
                    <div className="col-span-1">
                        <MeetingPopover leadId={leadId} clientName={clientName} variant="grid" />
                    </div>
                    {quickCreateItems.map(item => (
                        <button
                            key={item.label}
                            onClick={async () => {
                                if (item.label === "Contract") {
                                    window.location.href = `/leads/${leadId}/contracts?action=create`;
                                } else if (item.label === "Estimate") {
                                    try {
                                        const { createDraftLeadEstimate } = await import("@/lib/actions");
                                        const estimate = await createDraftLeadEstimate(leadId);
                                        if (estimate) {
                                            window.location.href = `/leads/${leadId}/estimates/${estimate.id}`;
                                        }
                                    } catch (err) {
                                        console.error("Failed to create estimate:", err);
                                        toast.error("Failed to create estimate");
                                    }
                                } else {
                                    toast.info(`${item.label} coming soon`);
                                }
                            }}
                            className="flex flex-col items-center justify-center gap-1.5 p-2 h-16 rounded border border-slate-200 hover:bg-slate-50 hover:border-slate-300 transition-all text-slate-600 hover:text-slate-800 group"
                        >
                            <span className="text-slate-400 group-hover:text-slate-600 transition shrink-0">{item.icon}</span>
                            <span className="text-[9px] font-medium leading-tight text-center truncate w-full px-1">{item.label}</span>
                        </button>
                    ))}
                </div>
            </div>

            {/* Convert to Project */}
            <div className="px-4 py-3 border-t border-hui-border">
                <button
                    onClick={onConvert}
                    className="w-full py-2.5 bg-slate-800 hover:bg-slate-900 border border-transparent text-white text-sm font-semibold rounded-lg transition shadow-sm hover:shadow"
                >
                    Convert to Project
                </button>

                {/* More Actions */}
                <div className="relative mt-3">
                    <button
                        onClick={() => setShowMoreActions(!showMoreActions)}
                        className="w-full flex items-center justify-center gap-1 text-sm text-slate-700 hover:text-slate-900 transition font-medium py-1"
                    >
                        More Actions
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={`transition-transform ${showMoreActions ? "rotate-180" : ""}`}>
                            <path d="M6 9l6 6 6-6"/>
                        </svg>
                    </button>

                    {showMoreActions && (
                        <div className="mt-1 bg-white border border-slate-200 rounded-lg shadow-lg overflow-hidden z-20 relative">
                            {moreActions.map(action => (
                                <button
                                    key={action.label}
                                    onClick={() => { action.action(); setShowMoreActions(false); }}
                                    className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-slate-50 transition ${
                                        (action as any).danger ? "text-red-600 hover:bg-red-50" : "text-slate-700"
                                    }`}
                                >
                                    <span>{action.icon}</span>
                                    {action.label}
                                </button>
                            ))}
                        </div>
                    )}
                </div>

                {/* Need more info */}
                <button className="w-full mt-3 py-2 bg-green-50 text-green-700 text-xs font-bold rounded-lg hover:bg-green-100 transition border border-green-200">
                    Need more info?
                </button>
            </div>
        </div>
    );
}
