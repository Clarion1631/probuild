"use client";
import { useState, useTransition } from "react";
import { createLeadNote } from "@/lib/lead-note-actions";
import { toast } from "sonner";

interface Note {
    id: string;
    content: string;
    createdBy: string;
    createdAt: Date;
}

interface Props {
    leadId: string;
    initialNotes: Note[];
    userName: string;
}

export default function LeadNotesPageClient({ leadId, initialNotes, userName }: Props) {
    const [notes, setNotes] = useState<Note[]>(initialNotes);
    const [content, setContent] = useState("");
    const [isPending, startTransition] = useTransition();

    const handleAdd = () => {
        if (!content.trim()) return;
        startTransition(async () => {
            try {
                const note = await createLeadNote(leadId, content, userName);
                setNotes(prev => [note as Note, ...prev]);
                setContent("");
                toast.success("Note added");
            } catch {
                toast.error("Failed to add note");
            }
        });
    };

    return (
        <div className="max-w-2xl mx-auto py-8 px-6 space-y-6">
            <h1 className="text-2xl font-bold text-hui-textMain">Notes</h1>

            {/* Add Note */}
            <div className="hui-card p-4 space-y-3">
                <textarea
                    className="hui-input w-full resize-none"
                    rows={3}
                    placeholder="Add a note…"
                    value={content}
                    onChange={e => setContent(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleAdd(); }}
                />
                <div className="flex items-center justify-between">
                    <span className="text-xs text-hui-textMuted">⌘ + Enter to submit</span>
                    <button onClick={handleAdd} disabled={isPending || !content.trim()} className="hui-btn hui-btn-primary text-sm disabled:opacity-50">
                        {isPending ? "Adding…" : "Add Note"}
                    </button>
                </div>
            </div>

            {/* Notes List */}
            {notes.length === 0 ? (
                <div className="hui-card p-8 text-center text-hui-textMuted text-sm">No notes yet. Add one above.</div>
            ) : (
                <div className="space-y-3">
                    {notes.map(note => (
                        <div key={note.id} className="hui-card p-4">
                            <p className="text-sm text-hui-textMain whitespace-pre-wrap">{note.content}</p>
                            <div className="flex items-center gap-2 mt-3 text-xs text-hui-textMuted">
                                <span className="font-medium">{note.createdBy}</span>
                                <span>·</span>
                                <span>{new Date(note.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
