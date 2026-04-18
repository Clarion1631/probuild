"use client";

import { useState, useRef, useEffect } from "react";
import { updateProjectName, updateProjectLocation } from "@/lib/actions";
import { toast } from "sonner";
import { useRouter } from "next/navigation";

interface ProjectHeaderProps {
    projectId: string;
    name: string;
    clientName: string;
    location: string | null;
    status: string;
}

export default function ProjectHeader({ projectId, name, clientName, location, status }: ProjectHeaderProps) {
    const [editing, setEditing] = useState(false);
    const [value, setValue] = useState(name);
    const [saving, setSaving] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    const [editingLocation, setEditingLocation] = useState(false);
    const [locationValue, setLocationValue] = useState(location || "");
    const [savingLocation, setSavingLocation] = useState(false);
    const locationInputRef = useRef<HTMLInputElement>(null);
    const locationEscapedRef = useRef(false);

    const router = useRouter();

    useEffect(() => {
        if (editing && inputRef.current) {
            inputRef.current.focus();
            inputRef.current.select();
        }
    }, [editing]);

    useEffect(() => {
        if (editingLocation && locationInputRef.current) {
            locationInputRef.current.focus();
            locationInputRef.current.select();
        }
    }, [editingLocation]);

    const handleSaveLocation = async () => {
        if (locationEscapedRef.current) { locationEscapedRef.current = false; return; }
        const trimmed = locationValue.trim();
        setSavingLocation(true);
        try {
            await updateProjectLocation(projectId, trimmed);
            toast.success("Location updated");
            setEditingLocation(false);
            router.refresh();
        } catch (e: any) {
            toast.error(e.message || "Failed to update location");
            setLocationValue(location || "");
            setEditingLocation(false);
        } finally {
            setSavingLocation(false);
        }
    };

    const handleSave = async () => {
        const trimmed = value.trim();
        if (!trimmed || trimmed === name) {
            setValue(name);
            setEditing(false);
            return;
        }
        setSaving(true);
        try {
            await updateProjectName(projectId, trimmed);
            toast.success("Project name updated");
            setEditing(false);
            router.refresh();
        } catch (e: any) {
            toast.error(e.message || "Failed to update name");
            setValue(name);
            setEditing(false);
        } finally {
            setSaving(false);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Enter") handleSave();
        if (e.key === "Escape") { setValue(name); setEditing(false); }
    };

    const statusLabel = status || "Active";
    const statusClass =
        statusLabel === "Active" || statusLabel === "In Progress" ? "bg-green-100 text-green-700" :
        statusLabel === "Completed" ? "bg-purple-100 text-purple-700" :
        statusLabel === "On Hold" ? "bg-amber-100 text-amber-700" :
        "bg-slate-100 text-slate-600";

    return (
        <div className="flex items-center justify-between mb-8">
            <div>
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-xl flex items-center justify-center shadow-lg shadow-indigo-500/25">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>
                    </div>
                    <div>
                        {editing ? (
                            <input
                                ref={inputRef}
                                value={value}
                                onChange={e => setValue(e.target.value)}
                                onBlur={handleSave}
                                onKeyDown={handleKeyDown}
                                disabled={saving}
                                className="text-2xl font-bold text-hui-textMain bg-transparent border-b-2 border-indigo-400 outline-none px-0 py-0 w-full min-w-[200px]"
                            />
                        ) : (
                            <h1
                                className="text-2xl font-bold text-hui-textMain group/name cursor-pointer flex items-center gap-2"
                                onClick={() => setEditing(true)}
                                title="Click to rename"
                            >
                                {name}
                                <svg
                                    className="w-4 h-4 text-slate-300 opacity-0 group-hover/name:opacity-100 transition"
                                    fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2"
                                >
                                    <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                                    <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                                </svg>
                            </h1>
                        )}
                        <p className="text-sm text-hui-textMuted group/location flex items-center gap-1">
                            {clientName} ·{" "}
                            {editingLocation ? (
                                <input
                                    ref={locationInputRef}
                                    value={locationValue}
                                    onChange={e => setLocationValue(e.target.value)}
                                    onBlur={handleSaveLocation}
                                    onKeyDown={e => {
                                        if (e.key === "Enter") handleSaveLocation();
                                        if (e.key === "Escape") { locationEscapedRef.current = true; setLocationValue(location || ""); setEditingLocation(false); }
                                    }}
                                    disabled={savingLocation}
                                    placeholder="Add location"
                                    className="bg-transparent border-b border-indigo-400 outline-none text-sm text-hui-textMuted min-w-[180px]"
                                />
                            ) : (
                                <span
                                    className="cursor-pointer hover:text-hui-textMain flex items-center gap-1"
                                    onClick={() => setEditingLocation(true)}
                                    title="Click to edit location"
                                >
                                    {location || "No location"}
                                    <svg className="w-3 h-3 opacity-0 group-hover/location:opacity-100 [@media(hover:none)]:opacity-100 transition" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                                        <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                                        <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                                    </svg>
                                </span>
                            )}
                        </p>
                    </div>
                </div>
            </div>
            <div className="flex items-center gap-2">
                <span className={`text-xs font-semibold px-3 py-1.5 rounded-full ${statusClass}`}>{statusLabel}</span>
            </div>
        </div>
    );
}
