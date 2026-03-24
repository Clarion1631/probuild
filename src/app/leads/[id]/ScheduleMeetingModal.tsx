"use client";

import { useState } from "react";
import { createLeadMeeting } from "@/lib/actions";
import { toast } from "sonner";
import { useRouter } from "next/navigation";

interface ScheduleMeetingModalProps {
    leadId: string;
    clientName: string;
    onClose: () => void;
}

const meetingTypes = [
    {
        key: "Phone Call",
        label: "Phone Call",
        duration: 30,
        via: "via phone",
        icon: (
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                <rect width="24" height="24" rx="6" fill="#F59E0B" />
                <path d="M16.5 14.35v1.8a1.2 1.2 0 01-1.31 1.2 11.88 11.88 0 01-5.18-1.84 11.7 11.7 0 01-3.6-3.6A11.88 11.88 0 014.57 6.7 1.2 1.2 0 015.76 5.4h1.8a1.2 1.2 0 011.2 1.03c.08.58.22 1.14.42 1.69a1.2 1.2 0 01-.27 1.26l-.76.76a9.6 9.6 0 003.6 3.6l.76-.76a1.2 1.2 0 011.26-.27c.55.2 1.11.34 1.69.42a1.2 1.2 0 011.04 1.22z" fill="white" />
            </svg>
        ),
    },
    {
        key: "Onsite Visit",
        label: "Onsite Visit",
        duration: 60,
        via: "via in-person meeting",
        icon: (
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                <rect width="24" height="24" rx="6" fill="#F59E0B" />
                <path d="M12 7a2.5 2.5 0 100 5 2.5 2.5 0 000-5zm0 1a1.5 1.5 0 110 3 1.5 1.5 0 010-3zm0 4.5c-3.5 0-6 1.75-6 3.5v1h12v-1c0-1.75-2.5-3.5-6-3.5z" fill="white" />
            </svg>
        ),
    },
    {
        key: "Video Call",
        label: "Video Call",
        duration: 60,
        via: "via Google Meet",
        icon: (
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                <rect width="24" height="24" rx="6" fill="#34A853" />
                <path d="M15 9.5l3-2.5v10l-3-2.5V17a1 1 0 01-1 1H7a1 1 0 01-1-1V7a1 1 0 011-1h7a1 1 0 011 1v2.5z" fill="white" />
            </svg>
        ),
    },
];

const videoApps = ["Google Meet", "Zoom", "Microsoft Teams"];

export default function ScheduleMeetingModal({ leadId, clientName, onClose }: ScheduleMeetingModalProps) {
    const router = useRouter();
    const [step, setStep] = useState(1);
    const [selectedType, setSelectedType] = useState("Video Call");
    const [videoApp, setVideoApp] = useState("Google Meet");
    const [description, setDescription] = useState("");
    const [date, setDate] = useState("");
    const [time, setTime] = useState("10:00");
    const [saving, setSaving] = useState(false);

    const selectedMeeting = meetingTypes.find(m => m.key === selectedType)!;

    const handleNext = () => {
        if (step === 1) {
            setStep(2);
        }
    };

    const handleBack = () => {
        if (step === 2) setStep(1);
    };

    const handleSchedule = async () => {
        if (!date) {
            toast.error("Please select a date");
            return;
        }
        setSaving(true);
        try {
            const scheduledAt = `${date}T${time}:00`;
            await createLeadMeeting(leadId, {
                title: `${selectedType} with ${clientName}`,
                meetingType: selectedType,
                duration: selectedMeeting.duration,
                scheduledAt,
                videoApp: selectedType === "Video Call" ? videoApp : null,
                description: description || null,
            });
            toast.success("Meeting scheduled!");
            onClose();
            router.refresh();
        } catch (e: any) {
            toast.error(e.message || "Failed to schedule meeting");
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
            <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full overflow-hidden" onClick={e => e.stopPropagation()}>
                {/* Close button */}
                <div className="flex justify-end p-3 pb-0">
                    <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition text-xl leading-none">&times;</button>
                </div>

                {/* Step indicator */}
                <div className="px-8 pb-2">
                    <p className="text-xs text-slate-500">{step} of 2</p>
                    <h2 className="text-xl font-bold text-hui-textMain mt-0.5">
                        {step === 1 ? "Choose a meeting type" : "Schedule your meeting"}
                    </h2>
                </div>

                {step === 1 ? (
                    /* ── Step 1: Choose meeting type ── */
                    <div className="px-8 pb-8">
                        <div className="space-y-3 mt-4">
                            {meetingTypes.map(type => (
                                <button
                                    key={type.key}
                                    onClick={() => setSelectedType(type.key)}
                                    className={`w-full text-left p-4 rounded-xl border-2 transition-all flex items-start gap-4 ${
                                        selectedType === type.key
                                            ? "border-hui-textMain bg-slate-50 shadow-sm"
                                            : "border-slate-200 hover:border-slate-300 hover:bg-slate-50/50"
                                    }`}
                                >
                                    {/* Radio */}
                                    <div className="mt-0.5 flex-shrink-0">
                                        <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition ${
                                            selectedType === type.key ? "border-hui-textMain" : "border-slate-300"
                                        }`}>
                                            {selectedType === type.key && (
                                                <div className="w-2.5 h-2.5 rounded-full bg-hui-textMain" />
                                            )}
                                        </div>
                                    </div>

                                    {/* Icon */}
                                    <div className="flex-shrink-0">{type.icon}</div>

                                    {/* Info */}
                                    <div className="flex-1">
                                        <p className="font-semibold text-hui-textMain">{type.label}</p>
                                        <p className="text-sm text-slate-500">{type.duration} minutes · {type.via}</p>
                                    </div>

                                    {/* Video app dropdown for Video Call */}
                                    {type.key === "Video Call" && selectedType === "Video Call" && (
                                        <div className="flex-shrink-0" onClick={e => e.stopPropagation()}>
                                            <label className="text-[10px] text-slate-500 block mb-0.5">Video Conferencing App</label>
                                            <select
                                                value={videoApp}
                                                onChange={e => setVideoApp(e.target.value)}
                                                className="text-sm border border-slate-200 rounded-lg px-3 py-1.5 bg-white text-slate-700 focus:ring-1 focus:ring-green-500 outline-none"
                                            >
                                                {videoApps.map(app => <option key={app} value={app}>{app}</option>)}
                                            </select>
                                        </div>
                                    )}
                                </button>
                            ))}
                        </div>

                        {/* Description */}
                        <div className="mt-4">
                            <textarea
                                value={description}
                                onChange={e => setDescription(e.target.value)}
                                placeholder="Description"
                                rows={3}
                                className="hui-input w-full text-sm resize-none"
                            />
                        </div>
                    </div>
                ) : (
                    /* ── Step 2: Pick date & time ── */
                    <div className="px-8 pb-8 mt-4">
                        {/* Summary of selected meeting type */}
                        <div className="flex items-center gap-3 p-3 bg-slate-50 border border-slate-200 rounded-lg mb-5">
                            {selectedMeeting.icon}
                            <div>
                                <p className="font-semibold text-sm text-hui-textMain">{selectedMeeting.label}</p>
                                <p className="text-xs text-slate-500">{selectedMeeting.duration} minutes · {selectedMeeting.via}</p>
                            </div>
                            <button
                                onClick={handleBack}
                                className="ml-auto text-xs text-green-600 hover:text-green-700 font-semibold hover:underline"
                            >
                                Change
                            </button>
                        </div>

                        {/* Date & Time */}
                        <div className="grid grid-cols-2 gap-4 mb-4">
                            <div>
                                <label className="block text-sm font-medium text-slate-700 mb-1">Date *</label>
                                <input
                                    type="date"
                                    value={date}
                                    onChange={e => setDate(e.target.value)}
                                    min={new Date().toISOString().split("T")[0]}
                                    className="hui-input w-full"
                                    autoFocus
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-slate-700 mb-1">Time</label>
                                <input
                                    type="time"
                                    value={time}
                                    onChange={e => setTime(e.target.value)}
                                    className="hui-input w-full"
                                />
                            </div>
                        </div>

                        {/* Duration display */}
                        <div className="flex items-center gap-2 mb-4 text-sm text-slate-600">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12,6 12,12 16,14"/></svg>
                            Duration: {selectedMeeting.duration} minutes
                        </div>

                        {/* Location for Onsite Visit */}
                        {selectedType === "Onsite Visit" && (
                            <div className="mb-4">
                                <label className="block text-sm font-medium text-slate-700 mb-1">Location</label>
                                <input
                                    type="text"
                                    placeholder="Enter meeting location..."
                                    className="hui-input w-full"
                                />
                            </div>
                        )}

                        {/* Description if entered */}
                        {description && (
                            <div className="p-3 bg-slate-50 border border-slate-100 rounded-lg text-sm text-slate-600 mb-4">
                                <p className="text-xs font-medium text-slate-500 mb-1">Description</p>
                                {description}
                            </div>
                        )}
                    </div>
                )}

                {/* Footer */}
                <div className="px-8 py-4 bg-slate-50 border-t border-slate-200 flex items-center justify-between">
                    {step === 2 ? (
                        <button
                            onClick={handleBack}
                            className="px-4 py-2.5 text-sm font-medium text-slate-600 border border-slate-200 rounded-lg hover:bg-white transition"
                        >
                            Back
                        </button>
                    ) : <div />}

                    <button
                        onClick={step === 1 ? handleNext : handleSchedule}
                        disabled={saving}
                        className="px-8 py-2.5 bg-hui-textMain text-white text-sm font-semibold rounded-lg hover:bg-slate-800 transition shadow-sm disabled:opacity-50"
                    >
                        {step === 1 ? "Next" : saving ? "Scheduling..." : "Schedule"}
                    </button>
                </div>
            </div>
        </div>
    );
}
