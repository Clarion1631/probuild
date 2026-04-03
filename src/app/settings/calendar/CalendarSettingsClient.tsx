"use client";
import { useState, useTransition } from "react";
import { saveCompanySettings } from "@/lib/actions";
import { toast } from "sonner";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DEFAULT_WORK_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];

interface Props {
    settings: { workDays?: string | null; workdayStart?: string | null; workdayEnd?: string | null } | null;
}

export default function CalendarSettingsClient({ settings }: Props) {
    const initialDays = settings?.workDays ? JSON.parse(settings.workDays) : DEFAULT_WORK_DAYS;
    const [workDays, setWorkDays] = useState<string[]>(initialDays);
    const [workdayStart, setWorkdayStart] = useState(settings?.workdayStart ?? "07:00");
    const [workdayEnd, setWorkdayEnd] = useState(settings?.workdayEnd ?? "17:00");
    const [isPending, startTransition] = useTransition();

    function toggleDay(day: string) {
        setWorkDays(prev => prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day]);
    }

    function handleSave() {
        startTransition(async () => {
            try {
                await saveCompanySettings({
                    workDays: JSON.stringify(workDays),
                    workdayStart,
                    workdayEnd,
                } as any);
                toast.success("Calendar settings saved");
            } catch {
                toast.error("Failed to save settings");
            }
        });
    }

    return (
        <div className="max-w-2xl mx-auto py-8 px-6 space-y-6">
            <div>
                <h1 className="text-2xl font-bold text-hui-textMain">Calendar Settings</h1>
                <p className="text-sm text-hui-textMuted mt-1">Set your work days and hours for scheduling.</p>
            </div>

            <div className="hui-card p-6 space-y-6">
                {/* Work days */}
                <div>
                    <label className="block text-sm font-semibold text-hui-textMain mb-3">Work Days</label>
                    <div className="flex gap-2">
                        {DAYS.map(day => (
                            <button
                                key={day}
                                onClick={() => toggleDay(day)}
                                className={`w-12 h-12 rounded-lg text-sm font-semibold border transition ${
                                    workDays.includes(day)
                                        ? "bg-hui-primary text-white border-hui-primary"
                                        : "bg-white text-hui-textMuted border-hui-border hover:border-hui-primary"
                                }`}
                            >
                                {day}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Work hours */}
                <div className="grid grid-cols-2 gap-4">
                    <div>
                        <label className="block text-sm font-semibold text-hui-textMain mb-1.5">Start Time</label>
                        <input
                            type="time"
                            value={workdayStart}
                            onChange={e => setWorkdayStart(e.target.value)}
                            className="hui-input w-full"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-semibold text-hui-textMain mb-1.5">End Time</label>
                        <input
                            type="time"
                            value={workdayEnd}
                            onChange={e => setWorkdayEnd(e.target.value)}
                            className="hui-input w-full"
                        />
                    </div>
                </div>

                <div className="flex justify-end">
                    <button onClick={handleSave} disabled={isPending} className="hui-btn hui-btn-primary text-sm disabled:opacity-50">
                        {isPending ? "Saving…" : "Save Calendar Settings"}
                    </button>
                </div>
            </div>
        </div>
    );
}
