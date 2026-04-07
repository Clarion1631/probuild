"use client";

import { useState } from "react";
import { saveWorkdayExceptions } from "@/lib/actions";
import { toast } from "sonner";
import Link from "next/link";

type Exception = { date: string; label: string; type: "holiday" | "workday" };

export default function ExceptionsClient({ initialExceptions }: { initialExceptions: Exception[] }) {
    const [exceptions, setExceptions] = useState<Exception[]>(initialExceptions);
    const [isSaving, setIsSaving] = useState(false);
    const [newDate, setNewDate] = useState("");
    const [newLabel, setNewLabel] = useState("");
    const [newType, setNewType] = useState<"holiday" | "workday">("holiday");

    function handleAdd() {
        if (!newDate || !newLabel.trim()) { toast.error("Date and label are required"); return; }
        if (exceptions.some(e => e.date === newDate)) { toast.error("Date already has an exception"); return; }
        setExceptions([...exceptions, { date: newDate, label: newLabel.trim(), type: newType }].sort((a, b) => a.date.localeCompare(b.date)));
        setNewDate(""); setNewLabel(""); setNewType("holiday");
    }

    function handleRemove(date: string) {
        setExceptions(exceptions.filter(e => e.date !== date));
    }

    async function handleSave() {
        setIsSaving(true);
        try {
            await saveWorkdayExceptions(exceptions);
            toast.success("Exceptions saved");
        } catch { toast.error("Failed to save"); }
        finally { setIsSaving(false); }
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const upcoming = exceptions.filter(e => new Date(`${e.date}T00:00:00`) >= today);
    const past = exceptions.filter(e => new Date(`${e.date}T00:00:00`) < today);

    return (
        <div className="max-w-3xl mx-auto p-6 space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <div className="flex items-center gap-2 mb-1">
                        <Link href="/settings/calendar" className="text-sm text-slate-500 hover:text-slate-700">Calendar</Link>
                        <span className="text-slate-300">/</span>
                        <span className="text-sm font-medium text-slate-700">Exceptions</span>
                    </div>
                    <h1 className="text-2xl font-bold text-slate-800">Workday Exceptions</h1>
                    <p className="text-sm text-slate-500 mt-1">Add holidays (days off) or extra workdays (e.g., Saturday catch-up) that override your regular schedule.</p>
                </div>
                <button onClick={handleSave} disabled={isSaving} className="hui-btn hui-btn-primary disabled:opacity-50">
                    {isSaving ? "Saving..." : "Save Changes"}
                </button>
            </div>

            {/* Add New */}
            <div className="bg-white rounded-xl border border-slate-200 p-5">
                <h3 className="font-semibold text-slate-800 mb-3">Add Exception</h3>
                <div className="flex items-end gap-3 flex-wrap">
                    <div>
                        <label className="text-xs font-medium text-slate-500 block mb-1">Date</label>
                        <input type="date" value={newDate} onChange={e => setNewDate(e.target.value)} className="hui-input text-sm" />
                    </div>
                    <div className="flex-1 min-w-[200px]">
                        <label className="text-xs font-medium text-slate-500 block mb-1">Label</label>
                        <input type="text" value={newLabel} onChange={e => setNewLabel(e.target.value)} onKeyDown={e => e.key === "Enter" && handleAdd()} placeholder="e.g., Independence Day, Saturday catch-up" className="hui-input text-sm w-full" />
                    </div>
                    <div>
                        <label className="text-xs font-medium text-slate-500 block mb-1">Type</label>
                        <select value={newType} onChange={e => setNewType(e.target.value as "holiday" | "workday")} className="hui-input text-sm">
                            <option value="holiday">Holiday (day off)</option>
                            <option value="workday">Extra workday</option>
                        </select>
                    </div>
                    <button onClick={handleAdd} className="hui-btn hui-btn-secondary text-sm">Add</button>
                </div>
            </div>

            {/* Upcoming */}
            {upcoming.length > 0 && (
                <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                    <div className="px-5 py-3 bg-slate-50 border-b border-slate-200">
                        <h3 className="font-semibold text-slate-700 text-sm">Upcoming ({upcoming.length})</h3>
                    </div>
                    <div className="divide-y divide-slate-100">
                        {upcoming.map(ex => (
                            <div key={ex.date} className="flex items-center px-5 py-3 group hover:bg-slate-50 transition">
                                <div className={`w-2 h-2 rounded-full mr-3 ${ex.type === "holiday" ? "bg-red-400" : "bg-blue-400"}`} />
                                <span className="text-sm font-medium text-slate-800 w-32">{new Date(ex.date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span>
                                <span className="flex-1 text-sm text-slate-600">{ex.label}</span>
                                <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${ex.type === "holiday" ? "bg-red-50 text-red-600" : "bg-blue-50 text-blue-600"}`}>
                                    {ex.type === "holiday" ? "Day Off" : "Extra Workday"}
                                </span>
                                <button onClick={() => handleRemove(ex.date)} className="ml-3 text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition">
                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                                </button>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Past */}
            {past.length > 0 && (
                <details className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                    <summary className="px-5 py-3 bg-slate-50 border-b border-slate-200 cursor-pointer text-sm font-semibold text-slate-500">Past ({past.length})</summary>
                    <div className="divide-y divide-slate-100">
                        {past.map(ex => (
                            <div key={ex.date} className="flex items-center px-5 py-3 group hover:bg-slate-50 transition opacity-60">
                                <div className={`w-2 h-2 rounded-full mr-3 ${ex.type === "holiday" ? "bg-red-400" : "bg-blue-400"}`} />
                                <span className="text-sm font-medium text-slate-800 w-32">{new Date(ex.date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span>
                                <span className="flex-1 text-sm text-slate-600">{ex.label}</span>
                                <button onClick={() => handleRemove(ex.date)} className="ml-3 text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition">
                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                                </button>
                            </div>
                        ))}
                    </div>
                </details>
            )}

            {exceptions.length === 0 && (
                <div className="text-center py-12">
                    <svg className="w-12 h-12 mx-auto text-slate-300 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                    <p className="text-sm font-medium text-slate-500">No exceptions set</p>
                    <p className="text-xs text-slate-400 mt-1">Add holidays or extra workdays above</p>
                </div>
            )}
        </div>
    );
}
