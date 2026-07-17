"use client";

import { useState, useRef, useEffect } from "react";
import ScheduleMeetingModal from "./ScheduleMeetingModal";
import { toast } from "sonner";

interface MeetingPopoverProps {
    leadId: string;
    clientName: string;
    variant?: "default" | "grid" | "list";
    onClose?: () => void;
}

export default function MeetingPopover({ leadId, clientName, variant = "default", onClose }: MeetingPopoverProps) {
    const [showPopover, setShowPopover] = useState(false);
    const [showScheduleModal, setShowScheduleModal] = useState(false);
    const popoverRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        function handleClickOutside(e: MouseEvent) {
            if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
                setShowPopover(false);
            }
        }
        if (showPopover) document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, [showPopover]);

    const handleShareCalendar = () => {
        const bookingLink = `${window.location.origin}/portal/booking/${leadId}`;
        navigator.clipboard.writeText(bookingLink).then(() => {
            toast.success("Booking link copied to clipboard!");
        }).catch(() => {
            toast.info("Booking link: " + bookingLink);
        });
        setShowPopover(false);
        onClose?.();
    };

    return (
        <div className="relative" ref={popoverRef}>
            <button
                onClick={() => setShowPopover(!showPopover)}
                className={`w-full transition-all text-slate-600 hover:text-slate-800 group ${
                    variant === "grid"
                        ? "flex flex-col items-center justify-center gap-1.5 p-2 h-16 rounded border border-slate-200 hover:bg-slate-50 hover:border-slate-300"
                        : variant === "list"
                        ? "flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-slate-50"
                        : "flex flex-col items-center justify-center gap-1.5 p-2.5 rounded-lg border border-slate-200 hover:bg-slate-50 hover:border-slate-300"
                }`}
            >
                <span className="text-slate-400 group-hover:text-slate-600 transition shrink-0">
                    <svg width={variant === "list" ? 15 : 18} height={variant === "list" ? 15 : 18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>
                    </svg>
                </span>
                <span className={variant === "list" ? "text-sm" : "text-[10px] font-medium leading-tight text-center"}>Meeting</span>
            </button>

            {/* Popover dropdown */}
            {showPopover && (
                <div className="absolute left-0 top-full mt-1 w-64 bg-white border border-slate-200 rounded-xl shadow-xl z-30 overflow-hidden animate-in fade-in slide-in-from-top-1 duration-150">
                    <button
                        onClick={handleShareCalendar}
                        className="w-full text-left px-4 py-3.5 hover:bg-slate-50 transition flex items-start gap-3 border-b border-slate-100"
                    >
                        <span className="text-green-600 mt-0.5">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                                <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/>
                                <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/>
                            </svg>
                        </span>
                        <div>
                            <p className="text-sm font-semibold text-green-700">Share your calendar</p>
                            <p className="text-xs text-slate-500 mt-0.5">Allow your client to pick a time based on your availability</p>
                        </div>
                    </button>
                    <button
                        onClick={() => { setShowPopover(false); setShowScheduleModal(true); onClose?.(); }}
                        className="w-full text-left px-4 py-3.5 hover:bg-slate-50 transition flex items-start gap-3"
                    >
                        <span className="text-slate-500 mt-0.5">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                                <rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>
                                <path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/>
                            </svg>
                        </span>
                        <div>
                            <p className="text-sm font-semibold text-hui-textMain">Schedule a meeting</p>
                            <p className="text-xs text-slate-500 mt-0.5">Pick a time on your calendar and send your client an invite</p>
                        </div>
                    </button>
                </div>
            )}

            {/* Schedule Meeting Modal */}
            {showScheduleModal && (
                <ScheduleMeetingModal
                    leadId={leadId}
                    clientName={clientName}
                    onClose={() => setShowScheduleModal(false)}
                />
            )}
        </div>
    );
}
