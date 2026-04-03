"use client";

import { useState, useTransition, useRef } from "react";
import { useRouter } from "next/navigation";
import { createDailyLog, deleteDailyLog, deleteDailyLogPhoto } from "@/lib/actions";
import { toast } from "sonner";

// Weather icons mapping
const WEATHER_OPTIONS = [
    { label: "Sunny", icon: "☀️" },
    { label: "Partly Cloudy", icon: "⛅" },
    { label: "Cloudy", icon: "☁️" },
    { label: "Rainy", icon: "🌧️" },
    { label: "Stormy", icon: "⛈️" },
    { label: "Snowy", icon: "🌨️" },
    { label: "Windy", icon: "💨" },
    { label: "Foggy", icon: "🌫️" },
    { label: "Hot", icon: "🔥" },
    { label: "Cold", icon: "🥶" },
];

function getWeatherIcon(weather: string | null) {
    if (!weather) return "📋";
    const lower = weather.toLowerCase();
    for (const w of WEATHER_OPTIONS) {
        if (lower.includes(w.label.toLowerCase())) return w.icon;
    }
    return "🌤️";
}

function formatDate(dateStr: string) {
    const d = new Date(dateStr);
    return d.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

function formatShortDate(dateStr: string) {
    const d = new Date(dateStr);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function getCrewCount(crewOnSite: string | null) {
    if (!crewOnSite || crewOnSite.trim() === "") return 0;
    return crewOnSite.split(",").filter((s: string) => s.trim()).length;
}

type DailyLogPhoto = {
    id: string;
    url: string;
    caption: string | null;
    createdAt: string;
};

type DailyLog = {
    id: string;
    date: string;
    weather: string | null;
    crewOnSite: string | null;
    workPerformed: string;
    materialsDelivered: string | null;
    issues: string | null;
    photos: DailyLogPhoto[];
    createdBy: { id: string; name: string | null; email: string };
    createdAt: string;
    updatedAt: string;
};

interface Props {
    projectId: string;
    projectName: string;
    logs: DailyLog[];
    currentUserId: string;
    currentUserName: string;
}

export default function DailyLogsClient({ projectId, projectName, logs, currentUserId, currentUserName }: Props) {
    const router = useRouter();
    const [showForm, setShowForm] = useState(false);
    const [expandedLogId, setExpandedLogId] = useState<string | null>(null);
    const [isPending, startTransition] = useTransition();
    const [deletingId, setDeletingId] = useState<string | null>(null);
    const [photoLightbox, setPhotoLightbox] = useState<{ url: string; caption: string | null } | null>(null);
    const [exporting, setExporting] = useState(false);
    const [isGeneratingAI, setIsGeneratingAI] = useState(false);

    // Form state
    const [formDate, setFormDate] = useState(new Date().toISOString().split("T")[0]);
    const [formWeather, setFormWeather] = useState("");
    const [formTemp, setFormTemp] = useState("");
    const [formCrew, setFormCrew] = useState("");
    const [formWork, setFormWork] = useState("");
    const [formMaterials, setFormMaterials] = useState("");
    const [formIssues, setFormIssues] = useState("");
    const [formPhotos, setFormPhotos] = useState<File[]>([]);
    const [uploading, setUploading] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const resetForm = () => {
        setFormDate(new Date().toISOString().split("T")[0]);
        setFormWeather("");
        setFormTemp("");
        setFormCrew("");
        setFormWork("");
        setFormMaterials("");
        setFormIssues("");
        setFormPhotos([]);
    };

    const handlePhotoSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files || []);
        if (formPhotos.length + files.length > 10) {
            toast.error("Maximum 10 photos per log");
            return;
        }
        setFormPhotos(prev => [...prev, ...files]);
    };

    const removePhoto = (index: number) => {
        setFormPhotos(prev => prev.filter((_, i) => i !== index));
    };

    const uploadPhotosToSupabase = async (files: File[]): Promise<{ url: string; caption?: string }[]> => {
        const results: { url: string; caption?: string }[] = [];

        for (const file of files) {
            const formData = new FormData();
            formData.append("file", file);
            formData.append("path", `daily-logs/${projectId}/${Date.now()}-${file.name}`);

            const res = await fetch("/api/files", {
                method: "POST",
                body: formData,
            });

            if (res.ok) {
                const data = await res.json();
                results.push({ url: data.url, caption: file.name });
            }
        }

        return results;
    };

    const handleGenerateAI = async () => {
        if (!formWork.trim()) {
            toast.error("Please enter some brief notes in 'Work Performed' first.");
            return;
        }

        setIsGeneratingAI(true);
        try {
            const res = await fetch("/api/ai/daily-logs", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    notes: formWork + (formMaterials ? `\nMaterials: ${formMaterials}` : '') + (formIssues ? `\nIssues: ${formIssues}` : ''),
                    photoUrls: [] // Placeholder for future vision capability
                })
            });

            if (!res.ok) throw new Error("Failed to generate AI report");
            
            const data = await res.json();
            
            if (data.workPerformed) setFormWork(data.workPerformed);
            if (data.materialsDelivered) setFormMaterials(data.materialsDelivered);
            if (data.issues) setFormIssues(data.issues);
            
            // If weather wasn't explicitly set by user, suggest it if AI found it
            if (!formWeather && !formTemp && data.weather) {
                // simple heuristic to put it in formTemp
                setFormTemp(data.weather);
            }

            toast.success("AI draft generated successfully!");
        } catch (error) {
            console.error(error);
            toast.error("Failed to generate AI report. Try again.");
        } finally {
            setIsGeneratingAI(false);
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!formWork.trim()) {
            toast.error("Work performed is required");
            return;
        }

        setUploading(true);
        try {
            let photoUrls: { url: string; caption?: string }[] = [];
            if (formPhotos.length > 0) {
                photoUrls = await uploadPhotosToSupabase(formPhotos);
            }

            const weatherStr = formWeather ? `${formWeather}${formTemp ? `, ${formTemp}` : ""}` : formTemp || undefined;

            startTransition(async () => {
                try {
                    await createDailyLog(projectId, {
                        date: formDate,
                        weather: weatherStr,
                        crewOnSite: formCrew || undefined,
                        workPerformed: formWork,
                        materialsDelivered: formMaterials || undefined,
                        issues: formIssues || undefined,
                        createdById: currentUserId,
                        photoUrls: photoUrls.length > 0 ? photoUrls : undefined,
                    });
                    toast.success("Daily log created!");
                    resetForm();
                    setShowForm(false);
                    router.refresh();
                } catch (err: any) {
                    toast.error(err.message || "Failed to create log");
                }
            });
        } catch (err: any) {
            toast.error("Failed to upload photos");
        } finally {
            setUploading(false);
        }
    };

    const handleDelete = async (logId: string) => {
        if (!confirm("Delete this daily log? This cannot be undone.")) return;
        setDeletingId(logId);
        try {
            await deleteDailyLog(logId);
            toast.success("Log deleted");
            router.refresh();
        } catch {
            toast.error("Failed to delete log");
        } finally {
            setDeletingId(null);
        }
    };

    const handleExportPdf = async () => {
        setExporting(true);
        try {
            const res = await fetch(`/api/daily-logs/${projectId}/pdf`);
            if (!res.ok) throw new Error("Export failed");
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `daily-logs-${projectName.replace(/\s+/g, "-")}.pdf`;
            a.click();
            URL.revokeObjectURL(url);
            toast.success("PDF exported!");
        } catch {
            toast.error("Failed to export PDF");
        } finally {
            setExporting(false);
        }
    };

    // Group logs by month/year
    const groupedLogs: Record<string, DailyLog[]> = {};
    for (const log of logs) {
        const d = new Date(log.date);
        const key = d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
        if (!groupedLogs[key]) groupedLogs[key] = [];
        groupedLogs[key].push(log);
    }

    return (
        <div className="flex-1 flex flex-col items-stretch h-full overflow-hidden">
            {/* Header */}
            <div className="flex-none p-6 pb-4 border-b border-hui-border bg-white flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-hui-textMain">Daily Logs</h1>
                    <p className="text-sm text-hui-textMuted mt-1">
                        Track daily project activity, weather, crew, and progress.
                    </p>
                </div>
                <div className="flex items-center gap-3">
                    <button
                        onClick={handleExportPdf}
                        disabled={exporting || logs.length === 0}
                        className="hui-btn hui-btn-secondary flex items-center gap-2"
                    >
                        {exporting ? (
                            <span className="w-4 h-4 border-2 border-slate-300 border-t-slate-600 rounded-full animate-spin" />
                        ) : (
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                            </svg>
                        )}
                        Export PDF
                    </button>
                    <button
                        onClick={() => { resetForm(); setShowForm(true); }}
                        className="hui-btn hui-btn-primary flex items-center gap-2"
                    >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                        </svg>
                        Add Log
                    </button>
                </div>
            </div>

            {/* Timeline Content */}
            <div className="flex-1 overflow-y-auto p-6 bg-hui-background">
                {/* Stats bar */}
                <div className="grid grid-cols-3 gap-4 mb-6">
                    <div className="hui-card p-4 border-l-4 border-l-blue-500">
                        <p className="text-xs font-semibold text-hui-textMuted uppercase">Total Logs</p>
                        <p className="text-2xl font-bold text-hui-textMain mt-1">{logs.length}</p>
                    </div>
                    <div className="hui-card p-4 border-l-4 border-l-green-500">
                        <p className="text-xs font-semibold text-hui-textMuted uppercase">This Month</p>
                        <p className="text-2xl font-bold text-hui-textMain mt-1">
                            {logs.filter(l => {
                                const d = new Date(l.date);
                                const now = new Date();
                                return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
                            }).length}
                        </p>
                    </div>
                    <div className="hui-card p-4 border-l-4 border-l-amber-500">
                        <p className="text-xs font-semibold text-hui-textMuted uppercase">Total Photos</p>
                        <p className="text-2xl font-bold text-hui-textMain mt-1">
                            {logs.reduce((sum, l) => sum + l.photos.length, 0)}
                        </p>
                    </div>
                </div>

                {logs.length === 0 ? (
                    <div className="hui-card p-12 text-center">
                        <div className="w-16 h-16 bg-slate-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
                            <svg className="w-8 h-8 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                            </svg>
                        </div>
                        <h3 className="text-lg font-semibold text-hui-textMain mb-1">No daily logs yet</h3>
                        <p className="text-sm text-hui-textMuted mb-4">
                            Start tracking your project&apos;s daily activity by adding your first log.
                        </p>
                        <button
                            onClick={() => { resetForm(); setShowForm(true); }}
                            className="hui-btn hui-btn-green"
                        >
                            Add First Log
                        </button>
                    </div>
                ) : (
                    <div className="space-y-8">
                        {Object.entries(groupedLogs).map(([monthYear, monthLogs]) => (
                            <div key={monthYear}>
                                <h2 className="text-sm font-bold text-hui-textMuted uppercase tracking-wider mb-4 flex items-center gap-2">
                                    <span className="w-2 h-2 bg-hui-primary rounded-full" />
                                    {monthYear}
                                </h2>

                                {/* Vertical timeline */}
                                <div className="relative ml-4">
                                    {/* Timeline line */}
                                    <div className="absolute left-0 top-0 bottom-0 w-px bg-slate-200" />

                                    <div className="space-y-4">
                                        {monthLogs.map((log) => {
                                            const isExpanded = expandedLogId === log.id;
                                            const crewCount = getCrewCount(log.crewOnSite);
                                            const weatherIcon = getWeatherIcon(log.weather);

                                            return (
                                                <div key={log.id} className="relative pl-8">
                                                    {/* Timeline dot */}
                                                    <div className="absolute left-[-5px] top-5 w-[10px] h-[10px] rounded-full bg-white border-2 border-hui-primary z-10" />

                                                    <div
                                                        className={`hui-card overflow-hidden transition-all duration-200 cursor-pointer hover:shadow-md ${isExpanded ? "ring-1 ring-hui-primary/30" : ""}`}
                                                        onClick={() => setExpandedLogId(isExpanded ? null : log.id)}
                                                    >
                                                        {/* Compact header — always visible */}
                                                        <div className="p-4 flex items-center justify-between">
                                                            <div className="flex items-center gap-4 min-w-0 flex-1">
                                                                {/* Date badge */}
                                                                <div className="flex-shrink-0 w-14 h-14 bg-slate-50 border border-slate-200 rounded-xl flex flex-col items-center justify-center">
                                                                    <span className="text-[10px] font-bold text-hui-textMuted uppercase">
                                                                        {new Date(log.date).toLocaleDateString("en-US", { month: "short" })}
                                                                    </span>
                                                                    <span className="text-lg font-bold text-hui-textMain leading-tight">
                                                                        {new Date(log.date).getDate()}
                                                                    </span>
                                                                </div>

                                                                <div className="min-w-0 flex-1">
                                                                    <div className="flex items-center gap-2 flex-wrap">
                                                                        <h3 className="text-sm font-semibold text-hui-textMain">
                                                                            {formatDate(log.date)}
                                                                        </h3>
                                                                    </div>
                                                                    <p className="text-xs text-hui-textMuted mt-0.5 truncate">
                                                                        {log.workPerformed.substring(0, 120)}{log.workPerformed.length > 120 ? "..." : ""}
                                                                    </p>
                                                                    {log.photos.length > 0 && (
                                                                        <div className="flex items-center gap-1.5 mt-2">
                                                                            {log.photos.slice(0, 4).map((photo: DailyLogPhoto) => (
                                                                                <div
                                                                                    key={photo.id}
                                                                                    className="w-10 h-10 rounded-md overflow-hidden border border-slate-200 shrink-0 cursor-pointer hover:ring-2 hover:ring-hui-primary transition"
                                                                                    onClick={e => { e.stopPropagation(); setPhotoLightbox(photo); }}
                                                                                >
                                                                                    <img
                                                                                        src={photo.url}
                                                                                        alt={photo.caption || "photo"}
                                                                                        className="w-full h-full object-cover"
                                                                                    />
                                                                                </div>
                                                                            ))}
                                                                            {log.photos.length > 4 && (
                                                                                <div className="w-10 h-10 rounded-md bg-slate-100 border border-slate-200 flex items-center justify-center shrink-0">
                                                                                    <span className="text-[10px] font-semibold text-hui-textMuted">+{log.photos.length - 4}</span>
                                                                                </div>
                                                                            )}
                                                                        </div>
                                                                    )}
                                                                </div>
                                                            </div>

                                                            {/* Right side badges */}
                                                            <div className="flex items-center gap-3 shrink-0 ml-4">
                                                                {log.weather && (
                                                                    <span className="inline-flex items-center gap-1 text-xs bg-blue-50 text-blue-700 px-2 py-1 rounded-full">
                                                                        <span>{weatherIcon}</span>
                                                                        <span className="hidden sm:inline">{log.weather}</span>
                                                                    </span>
                                                                )}
                                                                {crewCount > 0 && (
                                                                    <span className="inline-flex items-center gap-1 text-xs bg-green-50 text-green-700 px-2 py-1 rounded-full">
                                                                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                                                                        </svg>
                                                                        {crewCount}
                                                                    </span>
                                                                )}
                                                                {log.photos.length > 0 && (
                                                                    <span className="inline-flex items-center gap-1 text-xs bg-purple-50 text-purple-700 px-2 py-1 rounded-full">
                                                                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                                                                        </svg>
                                                                        {log.photos.length}
                                                                    </span>
                                                                )}
                                                                {log.issues && (
                                                                    <span className="inline-flex items-center gap-1 text-xs bg-red-50 text-red-700 px-2 py-1 rounded-full">
                                                                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.732-.833-2.5 0L4.268 16.5c-.77.833.192 2.5 1.732 2.5z" />
                                                                        </svg>
                                                                        Issues
                                                                    </span>
                                                                )}
                                                                <svg
                                                                    className={`w-4 h-4 text-slate-400 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                                                                    fill="none" stroke="currentColor" viewBox="0 0 24 24"
                                                                >
                                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                                                                </svg>
                                                            </div>
                                                        </div>

                                                        {/* Expanded content */}
                                                        {isExpanded && (
                                                            <div className="border-t border-hui-border">
                                                                <div className="p-5 space-y-5">
                                                                    {/* Meta row */}
                                                                    <div className="flex items-center gap-4 text-xs text-hui-textMuted">
                                                                        <span>Logged by <strong className="text-hui-textMain">{log.createdBy.name || log.createdBy.email}</strong></span>
                                                                        <span>•</span>
                                                                        <span>{new Date(log.createdAt).toLocaleString()}</span>
                                                                    </div>

                                                                    {/* Weather & Crew */}
                                                                    <div className="grid grid-cols-2 gap-4">
                                                                        {log.weather && (
                                                                            <div className="bg-blue-50/50 border border-blue-100 rounded-lg p-3">
                                                                                <p className="text-[10px] font-bold text-blue-600 uppercase tracking-wider mb-1">Weather</p>
                                                                                <p className="text-sm text-hui-textMain">{weatherIcon} {log.weather}</p>
                                                                            </div>
                                                                        )}
                                                                        {log.crewOnSite && (
                                                                            <div className="bg-green-50/50 border border-green-100 rounded-lg p-3">
                                                                                <p className="text-[10px] font-bold text-green-600 uppercase tracking-wider mb-1">Crew on Site ({crewCount})</p>
                                                                                <p className="text-sm text-hui-textMain">{log.crewOnSite}</p>
                                                                            </div>
                                                                        )}
                                                                    </div>

                                                                    {/* Work Performed */}
                                                                    <div>
                                                                        <p className="text-[10px] font-bold text-hui-textMuted uppercase tracking-wider mb-2">Work Performed</p>
                                                                        <div className="text-sm text-hui-textMain whitespace-pre-wrap bg-slate-50 rounded-lg p-4 border border-slate-100">
                                                                            {log.workPerformed}
                                                                        </div>
                                                                    </div>

                                                                    {/* Materials Delivered */}
                                                                    {log.materialsDelivered && (
                                                                        <div>
                                                                            <p className="text-[10px] font-bold text-hui-textMuted uppercase tracking-wider mb-2">Materials Delivered</p>
                                                                            <div className="text-sm text-hui-textMain whitespace-pre-wrap bg-amber-50/50 rounded-lg p-4 border border-amber-100">
                                                                                {log.materialsDelivered}
                                                                            </div>
                                                                        </div>
                                                                    )}

                                                                    {/* Issues */}
                                                                    {log.issues && (
                                                                        <div>
                                                                            <p className="text-[10px] font-bold text-red-600 uppercase tracking-wider mb-2">⚠️ Issues / Delays</p>
                                                                            <div className="text-sm text-hui-textMain whitespace-pre-wrap bg-red-50/50 rounded-lg p-4 border border-red-100">
                                                                                {log.issues}
                                                                            </div>
                                                                        </div>
                                                                    )}

                                                                    {/* Photos */}
                                                                    {log.photos.length > 0 && (
                                                                        <div>
                                                                            <p className="text-[10px] font-bold text-hui-textMuted uppercase tracking-wider mb-2">Photos ({log.photos.length})</p>
                                                                            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                                                                                {log.photos.map(photo => (
                                                                                    <div
                                                                                        key={photo.id}
                                                                                        className="group relative aspect-square rounded-lg overflow-hidden border border-slate-200 cursor-pointer hover:ring-2 hover:ring-hui-primary transition"
                                                                                        onClick={(e) => { e.stopPropagation(); setPhotoLightbox(photo); }}
                                                                                    >
                                                                                        <img
                                                                                            src={photo.url}
                                                                                            alt={photo.caption || "Daily log photo"}
                                                                                            className="w-full h-full object-cover"
                                                                                        />
                                                                                        {photo.caption && (
                                                                                            <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent p-2">
                                                                                                <p className="text-[10px] text-white truncate">{photo.caption}</p>
                                                                                            </div>
                                                                                        )}
                                                                                    </div>
                                                                                ))}
                                                                            </div>
                                                                        </div>
                                                                    )}

                                                                    {/* Actions */}
                                                                    <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-100">
                                                                        <button
                                                                            onClick={(e) => { e.stopPropagation(); handleDelete(log.id); }}
                                                                            disabled={deletingId === log.id}
                                                                            className="text-xs text-red-500 hover:text-red-700 hover:bg-red-50 px-3 py-1.5 rounded transition"
                                                                        >
                                                                            {deletingId === log.id ? "Deleting..." : "Delete Log"}
                                                                        </button>
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Add Log Modal */}
            {showForm && (
                <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
                    <div
                        className="bg-white rounded-xl shadow-2xl max-w-2xl w-full max-h-[90vh] flex flex-col"
                        onClick={e => e.stopPropagation()}
                    >
                        <div className="flex items-center justify-between p-5 border-b border-hui-border">
                            <h2 className="text-lg font-bold text-hui-textMain">New Daily Log</h2>
                            <button onClick={() => setShowForm(false)} className="text-slate-400 hover:text-slate-600 text-xl">&times;</button>
                        </div>

                        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-5 space-y-5">
                            {/* Date */}
                            <div>
                                <label className="block text-sm font-medium text-hui-textMain mb-1">Date</label>
                                <input
                                    type="date"
                                    value={formDate}
                                    onChange={e => setFormDate(e.target.value)}
                                    className="hui-input w-full"
                                    required
                                />
                            </div>

                            {/* Weather */}
                            <div>
                                <label className="block text-sm font-medium text-hui-textMain mb-1">Weather</label>
                                <div className="flex gap-2 flex-wrap mb-2">
                                    {WEATHER_OPTIONS.map(w => (
                                        <button
                                            key={w.label}
                                            type="button"
                                            onClick={() => setFormWeather(formWeather === w.label ? "" : w.label)}
                                            className={`px-3 py-1.5 rounded-full text-xs font-medium border transition ${formWeather === w.label
                                                ? "bg-blue-100 border-blue-300 text-blue-800"
                                                : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50"
                                                }`}
                                        >
                                            {w.icon} {w.label}
                                        </button>
                                    ))}
                                </div>
                                <input
                                    type="text"
                                    placeholder='Temperature (e.g., "75°F")'
                                    value={formTemp}
                                    onChange={e => setFormTemp(e.target.value)}
                                    className="hui-input w-full"
                                />
                            </div>

                            {/* Crew */}
                            <div>
                                <label className="block text-sm font-medium text-hui-textMain mb-1">Crew on Site</label>
                                <textarea
                                    placeholder="Enter crew names, comma-separated (e.g., John, Mike, Sarah)"
                                    value={formCrew}
                                    onChange={e => setFormCrew(e.target.value)}
                                    className="hui-input w-full"
                                    rows={2}
                                />
                            </div>

                            {/* Work Performed */}
                            <div>
                                <div className="flex items-center justify-between mb-1">
                                    <label className="block text-sm font-medium text-hui-textMain">
                                        Work Performed & Notes <span className="text-red-500">*</span>
                                    </label>
                                    <button
                                        type="button"
                                        onClick={handleGenerateAI}
                                        disabled={isGeneratingAI}
                                        className="text-xs font-semibold text-purple-600 bg-purple-50 hover:bg-purple-100 px-2 py-1 rounded-md flex items-center gap-1 transition disabled:opacity-50"
                                    >
                                        {isGeneratingAI ? (
                                            <span className="w-3 h-3 border-2 border-purple-200 border-t-purple-600 rounded-full animate-spin" />
                                        ) : (
                                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                                            </svg>
                                        )}
                                        {isGeneratingAI ? "Drafting..." : "✨ AI Draft"}
                                    </button>
                                </div>
                                <textarea
                                    placeholder="Type shorthand notes here, then click ✨ AI Draft to expand..."
                                    value={formWork}
                                    onChange={e => setFormWork(e.target.value)}
                                    className="hui-input w-full"
                                    rows={4}
                                    required
                                />
                            </div>

                            {/* Materials Delivered */}
                            <div>
                                <label className="block text-sm font-medium text-hui-textMain mb-1">Materials Delivered (optional)</label>
                                <textarea
                                    placeholder="List any materials that were delivered today..."
                                    value={formMaterials}
                                    onChange={e => setFormMaterials(e.target.value)}
                                    className="hui-input w-full"
                                    rows={2}
                                />
                            </div>

                            {/* Issues */}
                            <div>
                                <label className="block text-sm font-medium text-hui-textMain mb-1">Issues / Delays (optional)</label>
                                <textarea
                                    placeholder="Note any issues, delays, or concerns..."
                                    value={formIssues}
                                    onChange={e => setFormIssues(e.target.value)}
                                    className="hui-input w-full"
                                    rows={2}
                                />
                            </div>

                            {/* Photo Upload */}
                            <div>
                                <label className="block text-sm font-medium text-hui-textMain mb-2">Photos (max 10)</label>
                                <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
                                    {formPhotos.map((file, idx) => (
                                        <div key={idx} className="relative aspect-square rounded-lg overflow-hidden border border-slate-200 group">
                                            <img
                                                src={URL.createObjectURL(file)}
                                                alt={`Photo ${idx + 1}`}
                                                className="w-full h-full object-cover"
                                            />
                                            <button
                                                type="button"
                                                onClick={() => removePhoto(idx)}
                                                className="absolute top-1 right-1 w-5 h-5 bg-red-500 text-white rounded-full text-[10px] font-bold flex items-center justify-center opacity-0 group-hover:opacity-100 transition"
                                            >
                                                ×
                                            </button>
                                        </div>
                                    ))}
                                    {formPhotos.length < 10 && (
                                        <button
                                            type="button"
                                            onClick={() => fileInputRef.current?.click()}
                                            className="aspect-square rounded-lg border-2 border-dashed border-slate-300 hover:border-hui-primary hover:bg-hui-primary/5 transition flex flex-col items-center justify-center gap-1 text-slate-400 hover:text-hui-primary"
                                        >
                                            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
                                            </svg>
                                            <span className="text-[10px] font-medium">Add Photo</span>
                                        </button>
                                    )}
                                </div>
                                <input
                                    ref={fileInputRef}
                                    type="file"
                                    accept="image/*"
                                    multiple
                                    onChange={handlePhotoSelect}
                                    className="hidden"
                                />
                            </div>

                            {/* Submit */}
                            <div className="flex items-center justify-end gap-3 pt-4 border-t border-hui-border">
                                <button
                                    type="button"
                                    onClick={() => setShowForm(false)}
                                    className="hui-btn hui-btn-secondary"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    disabled={isPending || uploading}
                                    className="hui-btn hui-btn-primary"
                                >
                                    {uploading ? "Uploading photos..." : isPending ? "Saving..." : "Save Log"}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* Photo Lightbox */}
            {photoLightbox && (
                <div
                    className="fixed inset-0 bg-black/80 z-[60] flex items-center justify-center p-4"
                    onClick={() => setPhotoLightbox(null)}
                >
                    <div className="relative max-w-4xl max-h-[90vh]" onClick={e => e.stopPropagation()}>
                        <button
                            onClick={() => setPhotoLightbox(null)}
                            className="absolute -top-10 right-0 text-white hover:text-slate-300 text-2xl font-bold"
                        >
                            &times;
                        </button>
                        <img
                            src={photoLightbox.url}
                            alt={photoLightbox.caption || "Photo"}
                            className="max-w-full max-h-[85vh] rounded-lg object-contain"
                        />
                        {photoLightbox.caption && (
                            <p className="text-white text-center mt-3 text-sm">{photoLightbox.caption}</p>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
