"use client";

// Team-side "add a candidate" into a client Decision — a peer suggestion
// ("Richard suggests") that lands as an Idea alongside the client's own
// picks. docs/specs/client-selections-playground.md Phase 1.

import { useState } from "react";
import { toast } from "sonner";
import { addTeamCandidate } from "@/lib/actions";

export default function AddCandidateModal({
    decisionId,
    decisionName,
    open,
    onClose,
    onAdded,
}: {
    decisionId: string;
    decisionName: string;
    open: boolean;
    onClose: () => void;
    onAdded: () => void;
}) {
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [imageUrl, setImageUrl] = useState("");
    const [vendorUrl, setVendorUrl] = useState("");
    const [price, setPrice] = useState("");
    const [submitting, setSubmitting] = useState(false);

    function handleClose() {
        if (submitting) return;
        setName("");
        setDescription("");
        setImageUrl("");
        setVendorUrl("");
        setPrice("");
        onClose();
    }

    async function handleSubmit() {
        if (!name.trim()) {
            toast.error("Give it a name.");
            return;
        }
        setSubmitting(true);
        try {
            await addTeamCandidate(decisionId, {
                name: name.trim(),
                description: description.trim() || undefined,
                imageUrl: imageUrl.trim() || undefined,
                vendorUrl: vendorUrl.trim() || undefined,
                price: price ? parseFloat(price) : undefined,
            });
            toast.success("Added as a candidate");
            handleClose();
            onAdded();
        } catch (e: any) {
            toast.error(e.message || "Couldn't add that candidate.");
        } finally {
            setSubmitting(false);
        }
    }

    if (!open) return null;

    return (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={handleClose}>
            <div className="bg-white rounded-xl shadow-2xl max-w-md w-full max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
                <div className="px-6 py-4 border-b border-hui-border">
                    <h3 className="text-lg font-bold text-hui-textMain">Add a candidate</h3>
                    <p className="text-xs text-hui-textMuted mt-0.5">Into &quot;{decisionName}&quot; — appears as a peer option for the client.</p>
                </div>
                <div className="p-6 space-y-4">
                    <div>
                        <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Name</label>
                        <input type="text" className="hui-input w-full mt-1" value={name} onChange={(e) => setName(e.target.value)} disabled={submitting} autoFocus />
                    </div>
                    <div>
                        <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Vendor link</label>
                        <input type="url" className="hui-input w-full mt-1" placeholder="https://..." value={vendorUrl} onChange={(e) => setVendorUrl(e.target.value)} disabled={submitting} />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Image URL</label>
                            <input type="url" className="hui-input w-full mt-1" placeholder="https://..." value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} disabled={submitting} />
                        </div>
                        <div>
                            <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">List price</label>
                            <input type="number" step="0.01" min="0" className="hui-input w-full mt-1" placeholder="0.00" value={price} onChange={(e) => setPrice(e.target.value)} disabled={submitting} />
                        </div>
                    </div>
                    <div>
                        <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Description <span className="normal-case font-normal">(optional)</span></label>
                        <textarea className="hui-input w-full mt-1" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} disabled={submitting} />
                    </div>
                </div>
                <div className="px-6 py-4 border-t border-hui-border flex justify-end gap-3 bg-slate-50 rounded-b-xl">
                    <button onClick={handleClose} disabled={submitting} className="hui-btn hui-btn-secondary">Cancel</button>
                    <button onClick={handleSubmit} disabled={submitting || !name.trim()} className="hui-btn hui-btn-green disabled:opacity-50">
                        {submitting ? "Adding…" : "Add candidate"}
                    </button>
                </div>
            </div>
        </div>
    );
}
