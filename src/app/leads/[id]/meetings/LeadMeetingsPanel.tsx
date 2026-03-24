"use client";

import { useState } from "react";
import { updateLeadMeeting, deleteLeadMeeting } from "@/lib/actions";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import ScheduleMeetingModal from "../ScheduleMeetingModal";

interface Meeting {
    id: string;
    title: string;
    meetingType: string;
    duration: number;
    scheduledAt: string;
    endAt: string;
    location: string | null;
    videoApp: string | null;
    description: string | null;
    status: string;
    createdAt: string;
    updatedAt: string;
}

interface LeadMeetingsPanelProps {
    leadId: string;
    clientName: string;
    meetings: Meeting[];
}

export default function LeadMeetingsPanel({ leadId, clientName, meetings }: LeadMeetingsPanelProps) {
    const router = useRouter();
    const [showScheduleModal, setShowScheduleModal] = useState(false);
    const [search, setSearch] = useState("");
    const [statusFilter, setStatusFilter] = useState("All");

    const statuses = ["Scheduled", "Completed", "Cancelled"];

    const getStatusColor = (status: string) => {
        switch (status) {
            case "Scheduled": return "bg-blue-100 text-blue-700 border-blue-200";
            case "Completed": return "bg-green-100 text-green-700 border-green-200";
            case "Cancelled": return "bg-red-100 text-red-700 border-red-200";
            default: return "bg-slate-100 text-slate-700 border-slate-200";
        }
    };

    const getTypeIcon = (type: string) => {
        switch (type) {
            case "Phone Call":
                return (
                    <div className="w-7 h-7 rounded-md bg-amber-100 flex items-center justify-center">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#D97706" strokeWidth="2"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"/></svg>
                    </div>
                );
            case "Onsite Visit":
                return (
                    <div className="w-7 h-7 rounded-md bg-amber-100 flex items-center justify-center">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#D97706" strokeWidth="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
                    </div>
                );
            case "Video Call":
                return (
                    <div className="w-7 h-7 rounded-md bg-green-100 flex items-center justify-center">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#16A34A" strokeWidth="2"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
                    </div>
                );
            default: return null;
        }
    };

    const filteredMeetings = meetings
        .filter(m => statusFilter === "All" || m.status === statusFilter)
        .filter(m => !search || m.title.toLowerCase().includes(search.toLowerCase()));

    const handleStatusChange = async (meetingId: string, newStatus: string) => {
        try {
            await updateLeadMeeting(meetingId, { status: newStatus });
            toast.success(`Meeting ${newStatus.toLowerCase()}`);
            router.refresh();
        } catch {
            toast.error("Failed to update status");
        }
    };

    const handleDelete = async (meetingId: string) => {
        if (!confirm("Delete this meeting?")) return;
        try {
            await deleteLeadMeeting(meetingId);
            toast.success("Meeting deleted");
            router.refresh();
        } catch {
            toast.error("Failed to delete meeting");
        }
    };

    const formatDate = (dateStr: string) => {
        const d = new Date(dateStr);
        return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
    };

    const formatTime = (dateStr: string) => {
        const d = new Date(dateStr);
        return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
    };

    return (
        <div className="flex-1 flex flex-col bg-white min-w-0">
            {/* Header */}
            <div className="px-6 py-4 border-b border-hui-border flex items-center justify-between bg-white sticky top-0 z-10">
                <h2 className="text-xl font-bold text-hui-textMain">Meetings</h2>
                <button
                    onClick={() => setShowScheduleModal(true)}
                    className="px-4 py-2 bg-hui-textMain text-white text-sm font-semibold rounded-lg hover:bg-slate-800 transition shadow-sm flex items-center gap-1.5"
                >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
                    Schedule Meeting
                </button>
            </div>

            {/* Filter Bar */}
            <div className="px-6 py-3 border-b border-hui-border flex items-center gap-3 flex-wrap bg-white">
                <div className="relative flex-shrink-0">
                    <svg className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
                    <input
                        type="text"
                        placeholder="Search"
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        className="pl-9 pr-3 py-1.5 text-sm border border-slate-200 rounded-lg bg-white focus:ring-1 focus:ring-green-500 focus:border-green-500 outline-none transition w-44"
                    />
                </div>
                <select
                    value={statusFilter}
                    onChange={e => setStatusFilter(e.target.value)}
                    className="text-sm border border-slate-200 rounded-lg px-3 py-1.5 bg-white text-slate-700 focus:ring-1 focus:ring-green-500 outline-none"
                >
                    <option value="All">Status: All</option>
                    {statuses.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto">
                {filteredMeetings.length === 0 ? (
                    /* Empty State */
                    <div className="flex flex-col items-center justify-center h-full text-center px-6">
                        <div className="w-48 h-48 mb-6 relative">
                            <div className="absolute inset-0 bg-gradient-to-br from-blue-50 to-slate-50 rounded-full"></div>
                            <div className="absolute inset-6 flex items-center justify-center">
                                <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="1">
                                    <rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>
                                    <path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/>
                                </svg>
                            </div>
                        </div>
                        <h3 className="text-xl font-bold text-hui-textMain mb-2">Schedule your first meeting</h3>
                        <p className="text-sm text-slate-500 max-w-sm mb-8">
                            Stay organized by scheduling meetings with your clients. Choose from phone calls, onsite visits, or video calls.
                        </p>
                        <button
                            onClick={() => setShowScheduleModal(true)}
                            className="px-6 py-3 bg-hui-textMain text-white text-sm font-semibold rounded-lg hover:bg-slate-800 transition shadow-sm"
                        >
                            Schedule Meeting
                        </button>
                    </div>
                ) : (
                    /* Meetings Table */
                    <table className="w-full">
                        <thead className="bg-slate-50 sticky top-0 z-[5]">
                            <tr className="border-b border-slate-200">
                                <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wider px-4 py-3">Meeting</th>
                                <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wider px-4 py-3">Type</th>
                                <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wider px-4 py-3">Date & Time</th>
                                <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wider px-4 py-3">Duration</th>
                                <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wider px-4 py-3">Status</th>
                                <th className="w-16 px-4 py-3"></th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                            {filteredMeetings.map(meeting => (
                                <tr key={meeting.id} className="hover:bg-slate-50/50 transition group">
                                    <td className="px-4 py-3">
                                        <div>
                                            <span className="text-sm font-medium text-hui-textMain">{meeting.title}</span>
                                            {meeting.description && (
                                                <p className="text-xs text-slate-500 mt-0.5 truncate max-w-[200px]">{meeting.description}</p>
                                            )}
                                        </div>
                                    </td>
                                    <td className="px-4 py-3">
                                        <div className="flex items-center gap-2">
                                            {getTypeIcon(meeting.meetingType)}
                                            <div>
                                                <span className="text-sm text-hui-textMain">{meeting.meetingType}</span>
                                                {meeting.videoApp && (
                                                    <p className="text-[10px] text-slate-400">{meeting.videoApp}</p>
                                                )}
                                            </div>
                                        </div>
                                    </td>
                                    <td className="px-4 py-3">
                                        <div>
                                            <span className="text-sm text-hui-textMain">{formatDate(meeting.scheduledAt)}</span>
                                            <p className="text-xs text-slate-500">{formatTime(meeting.scheduledAt)} – {formatTime(meeting.endAt)}</p>
                                        </div>
                                    </td>
                                    <td className="px-4 py-3">
                                        <span className="text-sm text-slate-600">{meeting.duration} min</span>
                                    </td>
                                    <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                                        <select
                                            value={meeting.status}
                                            onChange={e => handleStatusChange(meeting.id, e.target.value)}
                                            className={`appearance-none text-xs font-semibold px-2.5 py-1 pr-6 rounded-full border cursor-pointer ${getStatusColor(meeting.status)} focus:outline-none focus:ring-1 focus:ring-green-500`}
                                        >
                                            {statuses.map(s => <option key={s} value={s}>{s}</option>)}
                                        </select>
                                    </td>
                                    <td className="px-4 py-3 text-right">
                                        <button
                                            onClick={() => handleDelete(meeting.id)}
                                            className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-red-600 transition p-1"
                                        >
                                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3,6 5,6 21,6" /><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" /></svg>
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>

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
