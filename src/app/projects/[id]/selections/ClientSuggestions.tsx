"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { decideSelectionProposal } from "@/lib/actions";
import { isHttpUrl } from "@/lib/url-safety";
import { ImageOff, ExternalLink, Lightbulb } from "lucide-react";

interface Proposal {
    id: string;
    name: string;
    description: string | null;
    imageUrl: string | null;
    price: number | string | null;
    vendorUrl: string | null;
    clientNote: string | null;
    status: string;
    pmNote: string | null;
    decidedBy: { id: string; name: string | null; email: string } | null;
    decidedAt: string | null;
    createdAt: string;
}

interface Category {
    id: string;
    name: string;
}

interface Board {
    id: string;
    title: string;
    categories: Category[];
}

function statusBadge(status: string) {
    if (status === "Pending") return "bg-amber-100 text-amber-700";
    if (status === "Approved") return "bg-green-100 text-green-700";
    return "bg-slate-100 text-slate-600";
}

export default function ClientSuggestions({
    projectId,
    initialProposals,
    boards,
}: {
    projectId: string;
    initialProposals: Proposal[];
    boards: Board[];
}) {
    const router = useRouter();
    const [proposals, setProposals] = useState<Proposal[]>(initialProposals);

    // initialProposals is only the INITIAL value for useState — React never
    // re-derives state from a changed prop on its own. Without this, a
    // decided proposal keeps rendering as Pending (with live Approve/Decline
    // buttons) after router.refresh() re-fetches the server component below,
    // because local state was never told the prop changed.
    useEffect(() => {
        setProposals(initialProposals);
    }, [initialProposals]);

    // Approve dialog state
    const [approveFor, setApproveFor] = useState<Proposal | null>(null);
    const [approvePrice, setApprovePrice] = useState("");
    const [approveBoardId, setApproveBoardId] = useState("");
    const [approveCategoryId, setApproveCategoryId] = useState("");
    const [approveAddToFavorites, setApproveAddToFavorites] = useState(true);
    const [approveNote, setApproveNote] = useState("");
    const [approving, setApproving] = useState(false);

    // Decline dialog state
    const [declineFor, setDeclineFor] = useState<Proposal | null>(null);
    const [declineNote, setDeclineNote] = useState("");
    const [declining, setDeclining] = useState(false);

    const pending = proposals.filter((p) => p.status === "Pending");
    const decided = proposals.filter((p) => p.status !== "Pending");

    const selectedBoard = useMemo(
        () => boards.find((b) => b.id === approveBoardId) || null,
        [boards, approveBoardId]
    );

    function openApprove(proposal: Proposal) {
        setApproveFor(proposal);
        setApprovePrice(proposal.price != null ? String(proposal.price) : "");
        setApproveBoardId("");
        setApproveCategoryId("");
        setApproveAddToFavorites(true);
        setApproveNote("");
    }

    function openDecline(proposal: Proposal) {
        setDeclineFor(proposal);
        setDeclineNote("");
    }

    async function handleApprove() {
        if (!approveFor) return;
        setApproving(true);
        try {
            const result = await decideSelectionProposal(approveFor.id, {
                action: "approve",
                pmNote: approveNote || undefined,
                price: approvePrice ? parseFloat(approvePrice) : undefined,
                boardId: approveBoardId || undefined,
                categoryId: approveBoardId ? (approveCategoryId || undefined) : undefined,
                addToFavorites: approveAddToFavorites,
            });
            if (!result.success) {
                toast.error("This suggestion was already decided.");
            } else {
                toast.success("Suggestion approved");
                // Optimistic: flip status locally so the Approve/Decline buttons
                // disappear immediately, rather than waiting on the
                // router.refresh() round-trip below to bring fresh server data.
                setProposals((prev) => prev.map((p) => (p.id === approveFor.id ? { ...p, status: "Approved" } : p)));
            }
            setApproveFor(null);
            router.refresh();
        } catch (e: any) {
            toast.error(e.message || "Failed to approve");
        } finally {
            setApproving(false);
        }
    }

    async function handleDecline() {
        if (!declineFor || !declineNote.trim()) return;
        setDeclining(true);
        try {
            const result = await decideSelectionProposal(declineFor.id, {
                action: "decline",
                pmNote: declineNote.trim(),
            });
            if (!result.success) {
                toast.error("This suggestion was already decided.");
            } else {
                toast.success("Suggestion declined");
                setProposals((prev) => prev.map((p) => (p.id === declineFor.id ? { ...p, status: "Declined" } : p)));
            }
            setDeclineFor(null);
            router.refresh();
        } catch (e: any) {
            toast.error(e.message || "Failed to decline");
        } finally {
            setDeclining(false);
        }
    }

    return (
        <div>
            <div className="mb-4">
                <h2 className="text-base font-semibold text-hui-textMain">Client Suggestions</h2>
                <p className="text-sm text-hui-textMuted mt-1">
                    Items the client suggested from their portal. Nothing here counts as an official selection until you approve it.
                </p>
            </div>

            {proposals.length === 0 ? (
                <div className="hui-card p-8 text-center">
                    <div className="w-12 h-12 bg-slate-100 rounded-2xl flex items-center justify-center mx-auto mb-3">
                        <Lightbulb className="w-6 h-6 text-slate-400" />
                    </div>
                    <p className="text-sm text-hui-textMuted">No client suggestions yet.</p>
                </div>
            ) : (
                <div className="hui-card divide-y divide-slate-100">
                    {[...pending, ...decided].map((p) => (
                        <div key={p.id} className="flex gap-4 p-4">
                            <div className="w-16 h-16 rounded-lg bg-slate-100 flex items-center justify-center overflow-hidden shrink-0">
                                {isHttpUrl(p.imageUrl) ? (
                                    <img src={p.imageUrl} alt={p.name} className="w-full h-full object-cover" />
                                ) : (
                                    <ImageOff className="w-5 h-5 text-slate-300" />
                                )}
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className="flex items-start justify-between gap-3">
                                    <div>
                                        <p className="text-sm font-semibold text-hui-textMain">{p.name}</p>
                                        {p.clientNote && (
                                            <p className="text-xs text-hui-textMuted mt-0.5">&quot;{p.clientNote}&quot;</p>
                                        )}
                                        {isHttpUrl(p.vendorUrl) && (
                                            <a
                                                href={p.vendorUrl}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="text-xs text-blue-600 hover:underline flex items-center gap-1 mt-1"
                                            >
                                                <ExternalLink className="w-3 h-3" />
                                                View link
                                            </a>
                                        )}
                                    </div>
                                    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full shrink-0 ${statusBadge(p.status)}`}>
                                        {p.status === "Pending" ? "Waiting for review" : p.status}
                                    </span>
                                </div>

                                {p.status === "Pending" ? (
                                    <div className="flex gap-2 mt-3">
                                        <button onClick={() => openApprove(p)} className="hui-btn hui-btn-green text-xs py-1.5 px-3">
                                            Approve
                                        </button>
                                        <button onClick={() => openDecline(p)} className="hui-btn hui-btn-secondary text-xs py-1.5 px-3">
                                            Decline
                                        </button>
                                    </div>
                                ) : (
                                    <div className="mt-2 text-xs text-hui-textMuted space-y-0.5">
                                        {p.status === "Approved" && p.price != null && (
                                            <p>Price: <span className="font-semibold text-hui-textMain">${Number(p.price).toLocaleString()}</span></p>
                                        )}
                                        {p.pmNote && <p>Note: &quot;{p.pmNote}&quot;</p>}
                                        {p.decidedBy && <p>Decided by {p.decidedBy.name || p.decidedBy.email}</p>}
                                    </div>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {/* Approve dialog */}
            {approveFor && (
                <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setApproveFor(null)}>
                    <div className="bg-white rounded-xl shadow-2xl max-w-md w-full" onClick={(e) => e.stopPropagation()}>
                        <div className="px-6 py-4 border-b border-hui-border">
                            <h3 className="text-lg font-bold text-hui-textMain">Approve suggestion</h3>
                            <p className="text-xs text-hui-textMuted mt-0.5">{approveFor.name}</p>
                        </div>
                        <div className="p-6 space-y-4">
                            <div>
                                <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Price</label>
                                <input
                                    type="number"
                                    step="0.01"
                                    min="0"
                                    value={approvePrice}
                                    onChange={(e) => setApprovePrice(e.target.value)}
                                    className="hui-input w-full mt-1"
                                    placeholder="0.00"
                                />
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Add to board (optional)</label>
                                    <select
                                        value={approveBoardId}
                                        onChange={(e) => { setApproveBoardId(e.target.value); setApproveCategoryId(""); }}
                                        className="hui-input w-full mt-1"
                                    >
                                        <option value="">— None —</option>
                                        {boards.map((b) => (
                                            <option key={b.id} value={b.id}>{b.title}</option>
                                        ))}
                                    </select>
                                </div>
                                <div>
                                    <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Category</label>
                                    <select
                                        value={approveCategoryId}
                                        onChange={(e) => setApproveCategoryId(e.target.value)}
                                        className="hui-input w-full mt-1 disabled:opacity-50"
                                        disabled={!selectedBoard || selectedBoard.categories.length === 0}
                                    >
                                        <option value="">— None —</option>
                                        {selectedBoard?.categories.map((c) => (
                                            <option key={c.id} value={c.id}>{c.name}</option>
                                        ))}
                                    </select>
                                </div>
                            </div>
                            <label className="flex items-center gap-2 text-sm text-hui-textMain">
                                <input
                                    type="checkbox"
                                    checked={approveAddToFavorites}
                                    onChange={(e) => setApproveAddToFavorites(e.target.checked)}
                                    className="w-4 h-4"
                                />
                                Add to project favorites
                            </label>
                            <div>
                                <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Note to client (optional)</label>
                                <textarea
                                    value={approveNote}
                                    onChange={(e) => setApproveNote(e.target.value)}
                                    className="hui-input w-full mt-1"
                                    rows={2}
                                />
                            </div>
                        </div>
                        <div className="px-6 py-4 border-t border-hui-border flex justify-end gap-3 bg-slate-50 rounded-b-xl">
                            <button onClick={() => setApproveFor(null)} className="hui-btn hui-btn-secondary" disabled={approving}>Cancel</button>
                            <button onClick={handleApprove} disabled={approving} className="hui-btn hui-btn-green disabled:opacity-50">
                                {approving ? "Approving..." : "Approve"}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Decline dialog */}
            {declineFor && (
                <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setDeclineFor(null)}>
                    <div className="bg-white rounded-xl shadow-2xl max-w-md w-full" onClick={(e) => e.stopPropagation()}>
                        <div className="px-6 py-4 border-b border-hui-border">
                            <h3 className="text-lg font-bold text-hui-textMain">Decline suggestion</h3>
                            <p className="text-xs text-hui-textMuted mt-0.5">{declineFor.name}</p>
                        </div>
                        <div className="p-6">
                            <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Reason (required, shown to client)</label>
                            <textarea
                                value={declineNote}
                                onChange={(e) => setDeclineNote(e.target.value)}
                                className="hui-input w-full mt-1"
                                rows={3}
                                autoFocus
                                placeholder="Let the client know why this didn't work..."
                            />
                        </div>
                        <div className="px-6 py-4 border-t border-hui-border flex justify-end gap-3 bg-slate-50 rounded-b-xl">
                            <button onClick={() => setDeclineFor(null)} className="hui-btn hui-btn-secondary" disabled={declining}>Cancel</button>
                            <button
                                onClick={handleDecline}
                                disabled={declining || !declineNote.trim()}
                                className="hui-btn hui-btn-primary disabled:opacity-50"
                            >
                                {declining ? "Declining..." : "Decline"}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
