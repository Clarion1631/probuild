"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { submitSelectionProposal } from "@/lib/actions";
import { isHttpUrl } from "@/lib/url-safety";
import { buildClipperBookmarklet } from "@/lib/clipper-bookmarklet";
import ClipperDragLink from "@/components/ClipperDragLink";
import { Link2, Copy } from "lucide-react";

const COULD_NOT_READ_PAGE_MESSAGE =
    "We couldn't read that page automatically. Just add the name (and a photo link if you have one) and we'll take it from there.";

interface Proposal {
    id: string;
    name: string;
    description: string | null;
    imageUrl: string | null;
    price: number | null;
    vendorUrl: string | null;
    clientNote: string | null;
    status: string;
    pmNote: string | null;
    createdAt: string;
}

function statusBadge(status: string) {
    if (status === "Approved") {
        return { label: "Approved", className: "bg-emerald-50 text-emerald-700" };
    }
    if (status === "Declined") {
        return { label: "Not this time", className: "bg-slate-100 text-slate-600" };
    }
    return { label: "Waiting for review", className: "bg-amber-50 text-amber-700" };
}

function SuggestItemModal({
    projectId,
    open,
    onClose,
    onSubmitted,
}: {
    projectId: string;
    open: boolean;
    onClose: () => void;
    onSubmitted: () => void;
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
        } catch (e: any) {
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
            });
            toast.success("Sent to your project manager for review.");
            reset();
            onClose();
            onSubmitted();
        } catch (e: any) {
            toast.error(e.message || "Couldn't send that suggestion. Please try again.");
        } finally {
            setSubmitting(false);
        }
    }

    if (!open) return null;

    return (
        <div
            className="fixed inset-0 bg-slate-900/50 flex items-center justify-center z-50 p-4"
            onClick={() => { if (!submitting) { reset(); onClose(); } }}
        >
            <div
                className="bg-white rounded-xl shadow-xl w-full max-w-md border border-hui-border max-h-[90vh] overflow-y-auto"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="px-6 py-4 border-b border-hui-border flex justify-between items-center">
                    <div>
                        <h2 className="text-base font-bold text-hui-textMain">Suggest an item</h2>
                        <p className="text-xs text-hui-textMuted mt-0.5">Found something you love? Send it our way.</p>
                    </div>
                    <button
                        onClick={() => { if (!submitting) { reset(); onClose(); } }}
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
                        <p className="text-xs text-hui-textMuted mt-1">We&apos;ll try to pull the name and photo. Price stays with your project manager for now.</p>
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
                        <label className="block text-sm font-medium text-hui-textMain mb-1">
                            Note to your project manager <span className="text-hui-textMuted font-normal">(optional)</span>
                        </label>
                        <textarea
                            className="hui-input"
                            rows={3}
                            placeholder="Why you like it, where it'd go, anything else..."
                            value={clientNote}
                            onChange={(e) => setClientNote(e.target.value)}
                            disabled={submitting}
                        />
                    </div>
                </div>

                <div className="px-6 py-4 border-t border-hui-border flex justify-end gap-3 bg-slate-50 rounded-b-xl">
                    <button
                        onClick={() => { if (!submitting) { reset(); onClose(); } }}
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
                        {submitting ? "Sending…" : "Send suggestion"}
                    </button>
                </div>
            </div>
        </div>
    );
}

function GetTheClipperCard({ projectId, appUrl }: { projectId: string; appUrl: string }) {
    const bookmarkletHref = buildClipperBookmarklet({
        origin: appUrl,
        targetPath: "/portal/clip",
        extraParams: { projectId },
    });

    async function handleCopyBookmarklet() {
        try {
            await navigator.clipboard.writeText(bookmarkletHref);
            toast.success("Clipper code copied! Create a new bookmark and paste this in as the URL.");
        } catch {
            toast.error("Couldn't copy that — try dragging the button instead.");
        }
    }

    return (
        <div className="hui-card p-5 mb-6 flex items-center justify-between gap-6 flex-wrap">
            <div className="flex items-center gap-4">
                <div className="w-11 h-11 bg-hui-primary/10 rounded-xl flex items-center justify-center shrink-0">
                    <Link2 className="w-5 h-5 text-hui-primary" />
                </div>
                <div>
                    <h2 className="text-base font-semibold text-hui-textMain">Get the Clipper</h2>
                    <p className="text-sm text-hui-textMuted mt-0.5 max-w-md">
                        Found something while shopping? Drag the ProBuild Clip button to your bookmarks bar.
                        <br />
                        On any product page, click it and the item comes straight here for your team to review.
                        <br />
                        Dragging not working on your device? Tap Copy, then make a new bookmark and paste it in as the URL.
                    </p>
                </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
                <ClipperDragLink
                    href={bookmarkletHref}
                    className="hui-btn hui-btn-secondary flex items-center gap-2 cursor-grab active:cursor-grabbing"
                    title="Drag me to your bookmarks bar"
                >
                    <Link2 className="w-4 h-4" />
                    ProBuild Clip
                </ClipperDragLink>
                <button
                    type="button"
                    onClick={handleCopyBookmarklet}
                    className="hui-btn hui-btn-secondary flex items-center gap-2"
                    title="Copy the clipper code"
                >
                    <Copy className="w-4 h-4" />
                    Copy
                </button>
            </div>
        </div>
    );
}

export default function PortalSuggestionsSection({
    projectId,
    initialProposals,
    appUrl,
}: {
    projectId: string;
    initialProposals: Proposal[];
    appUrl: string;
}) {
    const router = useRouter();
    const [modalOpen, setModalOpen] = useState(false);

    return (
        <div>
            <GetTheClipperCard projectId={projectId} appUrl={appUrl} />
            <div className="hui-card p-6">
            <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
                <div>
                    <h2 className="text-xl font-bold text-hui-textMain">Your suggestions</h2>
                    <p className="text-sm text-hui-textMuted">Items you&apos;ve sent us, and where they stand.</p>
                </div>
                <button onClick={() => setModalOpen(true)} className="hui-btn hui-btn-green">
                    Suggest an item
                </button>
            </div>

            {initialProposals.length === 0 ? (
                <div className="py-10 text-center">
                    <p className="text-sm text-hui-textMuted">
                        Found something you love? Send it to us and we&apos;ll price it out.
                    </p>
                </div>
            ) : (
                <div className="space-y-3">
                    {initialProposals.map(p => {
                        const badge = statusBadge(p.status);
                        return (
                            <div key={p.id} className="flex gap-4 border border-slate-200 rounded-lg p-4">
                                <div className="w-16 h-16 rounded-lg bg-slate-100 flex items-center justify-center overflow-hidden shrink-0">
                                    {isHttpUrl(p.imageUrl) ? (
                                        <img src={p.imageUrl} alt={p.name} className="w-full h-full object-cover" />
                                    ) : (
                                        <svg className="w-6 h-6 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                                        </svg>
                                    )}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-start justify-between gap-3 flex-wrap">
                                        <h4 className="font-bold text-slate-800 leading-tight">{p.name}</h4>
                                        <span className={`shrink-0 inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${badge.className}`}>
                                            {badge.label}
                                        </span>
                                    </div>
                                    {p.status === "Approved" && p.price != null && (
                                        <p className="text-sm font-semibold text-slate-700 mt-1">${p.price.toLocaleString()}</p>
                                    )}
                                    {p.clientNote && (
                                        <p className="text-xs text-hui-textMuted mt-1">You noted: {p.clientNote}</p>
                                    )}
                                    {p.pmNote && (
                                        <p className="text-sm text-slate-600 mt-1.5 bg-slate-50 rounded-md px-2.5 py-1.5">
                                            {p.status === "Declined" ? "From your project manager: " : "Note: "}{p.pmNote}
                                        </p>
                                    )}
                                    {isHttpUrl(p.vendorUrl) && (
                                        <a
                                            href={p.vendorUrl}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="text-xs font-semibold text-blue-600 hover:text-blue-800 inline-flex items-center gap-1 mt-2"
                                        >
                                            View link
                                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                                        </a>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
            </div>

            <SuggestItemModal
                projectId={projectId}
                open={modalOpen}
                onClose={() => setModalOpen(false)}
                onSubmitted={() => router.refresh()}
            />
        </div>
    );
}
