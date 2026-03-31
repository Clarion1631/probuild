"use client";

import { useState, useEffect } from "react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { getLeadNotes, createLeadNote } from "@/lib/lead-note-actions";

interface Note {
    id: string;
    content: string;
    createdBy: string | null;
    createdAt: Date;
}

interface LeadNotesModalProps {
    leadId: string;
    clientName: string;
    onClose: () => void;
}

export default function LeadNotesModal({ leadId, clientName, onClose }: LeadNotesModalProps) {
    const router = useRouter();
    const [notes, setNotes] = useState<Note[]>([]);
    const [newNote, setNewNote] = useState("");
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [aiGenerating, setAiGenerating] = useState(false);

    useEffect(() => {
        getLeadNotes(leadId)
            .then(data => {
                setNotes(data as any);
                setLoading(false);
            })
            .catch(err => {
                console.error(err);
                toast.error("Failed to load notes");
                setLoading(false);
            });
    }, [leadId]);

    const handleSaveNote = async () => {
        if (!newNote.trim()) return;
        setSaving(true);
        try {
            const added = await createLeadNote(leadId, newNote.trim(), "Team Member");
            setNotes(prev => [added as any, ...prev]);
            setNewNote("");
            toast.success("Note saved");
            router.refresh();
        } catch (err) {
            console.error(err);
            toast.error("Failed to save note");
        } finally {
            setSaving(false);
        }
    };

    const handleGenerateAI = async () => {
        setAiGenerating(true);
        try {
            const res = await fetch(`/api/leads/${leadId}/notes/ai`, {
                method: "POST",
            });
            if (!res.ok) throw new Error("AI Generation failed");
            const data = await res.json();
            if (data.suggestion) {
                setNewNote(prev => prev ? `${prev}\n\n${data.suggestion}` : data.suggestion);
                toast.success("AI Summary generated");
            }
        } catch (err) {
            console.error(err);
            toast.error("Failed to generate AI summary");
        } finally {
            setAiGenerating(false);
        }
    };

    return (
        <div className="fixed inset-0 bg-black/40 z-50 flex justify-end" onClick={onClose}>
            <div 
                className="bg-slate-50 w-[450px] h-full shadow-2xl flex flex-col transform transition-transform duration-300 translate-x-0" 
                onClick={e => e.stopPropagation()}
            >
                {/* Header */}
                <div className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between shrink-0 shadow-sm z-10">
                    <div>
                        <h2 className="text-lg font-bold text-slate-800">Notes & Internal Memo</h2>
                        <p className="text-sm text-slate-500">{clientName}</p>
                    </div>
                    <button onClick={onClose} className="text-slate-400 hover:text-slate-600 p-2 -mr-2 rounded-full hover:bg-slate-100 transition">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                    </button>
                </div>

                {/* Main Content Area */}
                <div className="flex-1 overflow-y-auto p-6 space-y-6">
                    {/* New Note Writer */}
                    <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-4 sticky top-0 z-10">
                        <textarea
                            value={newNote}
                            onChange={e => setNewNote(e.target.value)}
                            placeholder="Write an internal note..."
                            className="w-full text-sm text-slate-700 bg-transparent resize-none focus:outline-none min-h-[80px]"
                        />
                        <div className="flex items-center justify-between mt-3 pt-3 border-t border-slate-100">
                            <button
                                onClick={handleGenerateAI}
                                disabled={aiGenerating}
                                className="text-xs font-semibold px-3 py-1.5 rounded-md bg-purple-50 text-purple-700 flex items-center gap-1.5 hover:bg-purple-100 transition disabled:opacity-50"
                            >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2l3 6 6 3-6 3-3 6-3-6-6-3 6-3 3-6z"/></svg>
                                {aiGenerating ? "Summarizing..." : "AI Summary"}
                            </button>
                            <button
                                onClick={handleSaveNote}
                                disabled={saving || !newNote.trim()}
                                className="text-xs font-bold px-4 py-2 bg-slate-800 text-white rounded-lg hover:bg-slate-900 transition disabled:opacity-50 shadow-sm"
                            >
                                {saving ? "Saving..." : "Save Note"}
                            </button>
                        </div>
                    </div>

                    {/* Past Notes Feed */}
                    <div className="space-y-4">
                        <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Past Notes</h3>
                        {loading ? (
                            <div className="flex justify-center py-6"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-slate-800"></div></div>
                        ) : notes.length === 0 ? (
                            <p className="text-sm text-slate-500 text-center py-8 bg-slate-100/50 rounded-lg border border-slate-200/50">No internal notes yet.</p>
                        ) : (
                            notes.map(note => (
                                <div key={note.id} className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm relative">
                                    <div className="flex items-center justify-between mb-2">
                                        <div className="flex items-center gap-2">
                                            <div className="w-6 h-6 rounded-full bg-slate-200 flex items-center justify-center text-[10px] font-bold text-slate-600">
                                                {note.createdBy?.charAt(0) || "T"}
                                            </div>
                                            <span className="text-xs font-semibold text-slate-700">{note.createdBy}</span>
                                        </div>
                                        <span className="text-[10px] text-slate-400 font-medium">
                                            {new Date(note.createdAt).toLocaleDateString()} {new Date(note.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                        </span>
                                    </div>
                                    <p className="text-sm text-slate-600 whitespace-pre-wrap leading-relaxed">{note.content}</p>
                                </div>
                            ))
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
