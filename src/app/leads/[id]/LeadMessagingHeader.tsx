"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import Avatar from "@/components/Avatar";
import { updateLead } from "@/lib/actions";
import MeetingPopover from "./MeetingPopover";
import LeadNotesModal from "./LeadNotesModal";

interface LeadMessagingHeaderProps {
    leadId: string;
    leadName: string;
    clientName: string;
}

export default function LeadMessagingHeader({ leadId, leadName, clientName }: LeadMessagingHeaderProps) {
    const [nameValue, setNameValue] = useState(leadName);
    const [savedName, setSavedName] = useState(leadName);
    const [showNewDropdown, setShowNewDropdown] = useState(false);
    const [showNotesModal, setShowNotesModal] = useState(false);
    const savingRef = useRef(false);
    const isEditingRef = useRef(false);
    const newDropdownRef = useRef<HTMLDivElement>(null);
    const router = useRouter();

    useEffect(() => {
        if (!isEditingRef.current) {
            setNameValue(leadName);
            setSavedName(leadName);
        }
    }, [leadName]);

    useEffect(() => {
        function handleClick(e: MouseEvent) {
            if (newDropdownRef.current && !newDropdownRef.current.contains(e.target as Node)) {
                setShowNewDropdown(false);
            }
        }
        document.addEventListener("mousedown", handleClick);
        return () => document.removeEventListener("mousedown", handleClick);
    }, []);

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

    return (
        <>
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
                                size={Math.max(8, nameValue.length + 1)}
                                className="text-lg font-bold text-hui-textMain bg-transparent border-none outline-none min-w-0 max-w-xs hover:bg-slate-50 focus:bg-slate-50 rounded px-1 -ml-1 transition cursor-text"
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
                        <p className="text-xs px-1 -ml-1 flex items-center gap-1">
                            <span className="font-semibold text-amber-600 uppercase tracking-wider">Lead</span>
                            <span className="text-hui-textMuted">·</span>
                            <span className="text-hui-textMuted">{clientName}</span>
                        </p>
                    </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                    <div className="relative" ref={newDropdownRef}>
                        <button
                            onClick={() => setShowNewDropdown(prev => !prev)}
                            className="ml-2 px-4 py-1.5 bg-green-600 hover:bg-green-700 text-white text-sm font-semibold rounded-md transition shadow-sm flex items-center gap-1.5"
                        >
                            New
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className={`transition-transform ${showNewDropdown ? "rotate-180" : ""}`}>
                                <path d="M6 9l6 6 6-6"/>
                            </svg>
                        </button>
                        {showNewDropdown && (
                            <div className="absolute right-0 top-full mt-1.5 w-44 bg-white border border-slate-200 rounded-lg shadow-lg z-50 overflow-hidden">
                                <MeetingPopover leadId={leadId} clientName={clientName} variant="list" onClose={() => setShowNewDropdown(false)} />
                                <button
                                    onClick={async () => {
                                        setShowNewDropdown(false);
                                        try {
                                            const { createDraftLeadEstimate } = await import("@/lib/actions");
                                            const estimate = await createDraftLeadEstimate(leadId);
                                            if (estimate) window.location.href = `/leads/${leadId}/estimates/${estimate.id}`;
                                        } catch { toast.error("Failed to create estimate"); }
                                    }}
                                    className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 transition"
                                >
                                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>
                                    Estimate
                                </button>
                                <button
                                    onClick={() => { setShowNewDropdown(false); window.location.href = `/leads/${leadId}/contracts?action=create`; }}
                                    className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 transition"
                                >
                                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/></svg>
                                    Contract
                                </button>
                                <button
                                    onClick={() => { setShowNewDropdown(false); window.location.href = `/leads/${leadId}/tasks?action=create`; }}
                                    className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 transition"
                                >
                                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>
                                    Task
                                </button>
                                <button
                                    onClick={() => { setShowNewDropdown(false); setShowNotesModal(true); }}
                                    className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 transition"
                                >
                                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                                    Note
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {showNotesModal && (
                <LeadNotesModal
                    leadId={leadId}
                    clientName={clientName}
                    onClose={() => setShowNotesModal(false)}
                />
            )}
        </>
    );
}
