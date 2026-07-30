"use client";

// Shared "add an item" modal for the client selections playground. Used both
// as the general entry point (lands the item in Unsorted) and from inside a
// Decision card (decisionId set, lands the item straight in as a candidate).
// docs/specs/client-selections-playground.md Phase 1 — adding is ungated, so
// this never asks for "review", it just confirms the item was added.

import { useState } from "react";
import { toast } from "sonner";
import { submitSelectionProposal } from "@/lib/actions";
import { SELECTION_ITEM_NOTE_MAX_LENGTH } from "@/lib/selection-item-notes";

const COULD_NOT_READ_PAGE_MESSAGE =
    "We couldn't read that page automatically. Just add the name (and a photo link if you have one) and we'll take it from there.";

export default function AddItemModal({
    projectId,
    open,
    onClose,
    onSubmitted,
    decisionId,
    decisionName,
}: {
    projectId: string;
    open: boolean;
    onClose: () => void;
    onSubmitted: () => void;
    decisionId?: string;
    decisionName?: string;
}) {
    const [url, setUrl] = useState("");
    const [name, setName] = useState("");
    const [imageUrl, setImageUrl] = useState("");
    const [clientNote, setClientNote] = useState("");
    const [parsedDescription, setParsedDescription] = useState<string | undefined>(undefined);
    const [parsing, setParsing] = useState(false);
    const [submitting, setSubmitting] = useState(false);

    function reset() {
        setUrl("");
        setName("");
        setImageUrl("");
        setClientNote("");
        setParsedDescription(undefined);
    }

    function handleClose() {
        if (submitting) return;
        reset();
        onClose();
    }

    async function handleParse() {
        const trimmed = url.trim();
        if (!trimmed) return;
        setParsing(true);
        try {
            const res = await fetch(`/api/portal/projects/${projectId}/proposals/parse`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ url: trimmed }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || "Couldn't read that link");
            if (data.name) setName(data.name);
            if (data.imageUrl) setImageUrl(data.imageUrl);
            if (data.description) setParsedDescription(data.description);
            if (data.name || data.imageUrl) {
                toast.success("Filled in what we could find — feel free to edit it.");
            } else {
                toast.info(COULD_NOT_READ_PAGE_MESSAGE);
            }
        } catch {
            toast.error(COULD_NOT_READ_PAGE_MESSAGE);
        } finally {
            setParsing(false);
        }
    }

    async function handleSubmit() {
        if (!name.trim()) {
            toast.error("Give it a name so we know what you're pointing at.");
            return;
        }
        setSubmitting(true);
        try {
            await submitSelectionProposal(projectId, {
                url: url.trim() || undefined,
                name: name.trim(),
                description: parsedDescription,
                imageUrl: imageUrl.trim() || undefined,
                clientNote: clientNote.trim() || undefined,
                decisionId,
            });
            toast.success(decisionName ? `Added to "${decisionName}"` : "Added — sort it into a decision whenever you're ready.");
            reset();
            onClose();
            onSubmitted();
        } catch (e: any) {
            toast.error(e.message || "Couldn't add that item. Please try again.");
        } finally {
            setSubmitting(false);
        }
    }

    if (!open) return null;

    return (
        <div
            className="fixed inset-0 bg-slate-900/50 flex items-center justify-center z-50 p-4"
            onClick={handleClose}
        >
            <div
                className="bg-white rounded-xl shadow-xl w-full max-w-md border border-hui-border max-h-[90vh] overflow-y-auto"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="px-6 py-4 border-b border-hui-border flex justify-between items-center">
                    <div>
                        <h2 className="text-base font-bold text-hui-textMain">Add an item</h2>
                        <p className="text-xs text-hui-textMuted mt-0.5">
                            {decisionName ? `Adding to "${decisionName}"` : "Found something you love? Drop it in here."}
                        </p>
                    </div>
                    <button
                        onClick={handleClose}
                        aria-label="Close"
                        className="text-hui-textMuted hover:text-hui-textMain ml-4 shrink-0"
                    >
                        <svg aria-hidden="true" className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                </div>

                <div className="p-6 space-y-5">
                    <div>
                        <label className="block text-sm font-medium text-hui-textMain mb-1">Paste a product link</label>
                        <div className="flex gap-2">
                            <input
                                type="url"
                                className="hui-input"
                                placeholder="https://..."
                                value={url}
                                onChange={(e) => setUrl(e.target.value)}
                                disabled={submitting}
                            />
                            <button
                                type="button"
                                onClick={handleParse}
                                disabled={!url.trim() || parsing || submitting}
                                className="hui-btn hui-btn-secondary shrink-0 disabled:opacity-50"
                            >
                                {parsing ? "Parsing…" : "Parse"}
                            </button>
                        </div>
                        <p className="text-xs text-hui-textMuted mt-1">We&apos;ll try to pull the name and photo.</p>
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-hui-textMain mb-1">Item name</label>
                        <input
                            type="text"
                            className="hui-input"
                            placeholder="e.g. Brushed brass cabinet pulls"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            disabled={submitting}
                        />
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-hui-textMain mb-1">
                            Photo URL <span className="text-hui-textMuted font-normal">(optional)</span>
                        </label>
                        <input
                            type="url"
                            className="hui-input"
                            placeholder="https://..."
                            value={imageUrl}
                            onChange={(e) => setImageUrl(e.target.value)}
                            disabled={submitting}
                        />
                    </div>

                    <div>
                        <label
                            htmlFor="portal-add-item-note"
                            className="block text-sm font-medium text-hui-textMain mb-1"
                        >
                            Note to your project team <span className="text-hui-textMuted font-normal">(optional)</span>
                        </label>
                        <textarea
                            id="portal-add-item-note"
                            className="hui-input"
                            rows={3}
                            maxLength={SELECTION_ITEM_NOTE_MAX_LENGTH}
                            placeholder="Why you like it, where it'd go, anything else..."
                            value={clientNote}
                            onChange={(e) => setClientNote(e.target.value)}
                            disabled={submitting}
                        />
                    </div>
                </div>

                <div className="px-6 py-4 border-t border-hui-border flex justify-end gap-3 bg-slate-50 rounded-b-xl">
                    <button
                        onClick={handleClose}
                        className="hui-btn hui-btn-secondary"
                        disabled={submitting}
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleSubmit}
                        disabled={submitting || !name.trim()}
                        className="hui-btn hui-btn-green disabled:opacity-50"
                    >
                        {submitting ? "Adding…" : "Add item"}
                    </button>
                </div>
            </div>
        </div>
    );
}
