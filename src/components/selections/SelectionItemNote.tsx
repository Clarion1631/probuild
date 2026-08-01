"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { updateSelectionItemNote } from "@/lib/actions";
import { SELECTION_ITEM_NOTE_MAX_LENGTH } from "@/lib/selection-item-notes";

interface SelectionItemNoteProps {
    itemId: string;
    note: string | null;
    onSaved: () => void;
    className?: string;
}

export function SelectionItemNote({
    itemId,
    note,
    onSaved,
    className,
}: SelectionItemNoteProps) {
    const previewRef = useRef<HTMLParagraphElement>(null);
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState("");
    const [expanded, setExpanded] = useState(false);
    const [hasOverflow, setHasOverflow] = useState(false);
    const [saving, setSaving] = useState(false);
    const displayedNote = note?.trim() ?? "";

    useEffect(() => {
        setExpanded(false);
    }, [note]);

    useEffect(() => {
        if (expanded) return;
        const preview = previewRef.current;
        setHasOverflow(
            !!preview && preview.scrollHeight > preview.clientHeight + 1,
        );
    }, [expanded, note]);

    function startEditing() {
        setDraft(note ?? "");
        setEditing(true);
    }

    async function handleSave() {
        setSaving(true);
        try {
            await updateSelectionItemNote(itemId, draft);
            setEditing(false);
            setExpanded(false);
            toast.success(draft.trim() ? "Note saved" : "Note removed");
            onSaved();
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Couldn't save the note.",
            );
        } finally {
            setSaving(false);
        }
    }

    if (editing) {
        return (
            // basis-full: inside the card's flex-wrap action row the editor
            // must take the whole row even when it was opened from the inline
            // "Add note" link (no saved note → the parent passes no width).
            <div className={`${className ?? ""} basis-full`.trim()}>
                <textarea
                    aria-label="Selection item note"
                    className="hui-input w-full text-xs"
                    rows={4}
                    maxLength={SELECTION_ITEM_NOTE_MAX_LENGTH}
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    disabled={saving}
                />
                <div className="mt-1 flex items-center justify-between gap-2">
                    <span className="text-[11px] text-hui-textMuted">
                        {draft.length}/{SELECTION_ITEM_NOTE_MAX_LENGTH}
                    </span>
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            className="hui-btn hui-btn-secondary px-2.5 py-1 text-xs"
                            onClick={() => setEditing(false)}
                            disabled={saving}
                        >
                            Cancel
                        </button>
                        <button
                            type="button"
                            className="hui-btn hui-btn-green px-2.5 py-1 text-xs"
                            onClick={handleSave}
                            disabled={saving}
                        >
                            {saving ? "Saving…" : "Save note"}
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    if (!displayedNote) {
        return (
            <div className={className}>
                <button
                    type="button"
                    data-testid="selection-note-edit"
                    className="inline-flex items-center min-h-[32px] py-1 text-xs font-medium text-blue-600 hover:underline"
                    onClick={startEditing}
                >
                    Add note
                </button>
            </div>
        );
    }

    return (
        <div className={className}>
            {/* Tinted block so the note reads as a note at a glance instead of
                blending in with the item description. */}
            <div className="rounded-md bg-amber-50 border border-amber-100 px-2 py-1.5">
                {/* Non-color cue so the tint reads as "note", not a warning. */}
                <span className="block text-[10px] font-semibold uppercase tracking-wider text-amber-700">
                    Note
                </span>
                <p
                    ref={previewRef}
                    data-testid="selection-note-preview"
                    className={`whitespace-pre-wrap break-words text-xs text-slate-700 ${
                        // Notes are usually short — show them in full without a
                        // click. Only genuinely long notes get clamped behind
                        // Show more.
                        expanded || displayedNote.length <= 240 ? "" : "line-clamp-2"
                    }`}
                >
                    {displayedNote}
                </p>
                <div className="flex items-center gap-4">
                    {hasOverflow && (
                        <button
                            type="button"
                            data-testid="selection-note-toggle"
                            aria-expanded={expanded}
                            className="inline-flex items-center min-h-[32px] py-1 text-xs font-medium text-blue-600 hover:underline"
                            onClick={() => setExpanded((value) => !value)}
                        >
                            {expanded ? "Show less" : "Show more"}
                        </button>
                    )}
                    <button
                        type="button"
                        data-testid="selection-note-edit"
                        className="inline-flex items-center min-h-[32px] py-1 text-xs font-medium text-blue-600 hover:underline"
                        onClick={startEditing}
                    >
                        Edit note
                    </button>
                </div>
            </div>
        </div>
    );
}
