"use client";

// Team view of the client selections playground.
// docs/specs/client-selections-playground.md Phase 1 — "Approved Items" is
// the shared record of truth (what Richard buys); "Client Decisions" is the
// full working view with clipped list price for internal context only.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
    createDecision,
    renameDecision,
    reorderDecisions,
    deleteDecision,
    flagDecision,
    importBoardPicksAsDecisions,
} from "@/lib/actions";
import { isHttpUrl } from "@/lib/url-safety";
import AddCandidateModal from "./AddCandidateModal";
import {
    ImageOff,
    ExternalLink,
    Plus,
    Pencil,
    Trash2,
    ArrowUp,
    ArrowDown,
    CheckCircle2,
    Flag,
    Download,
    ClipboardList,
} from "lucide-react";

interface Candidate {
    id: string;
    name: string;
    description: string | null;
    imageUrl: string | null;
    vendorUrl: string | null;
    clientNote: string | null;
    status: string;
    pmNote: string | null;
    decisionId: string | null;
    price: number | string | null;
    createdAt: string;
}

interface DecisionData {
    id: string;
    projectId: string;
    name: string;
    area: string | null;
    status: string;
    chosenItemId: string | null;
    sortOrder: number;
    pmNote: string | null;
    candidates: Candidate[];
}

const ARCHIVED = "Archived";

function formatPrice(value: number | string | null | undefined): string | null {
    if (value === null || value === undefined || value === "") return null;
    const num = Number(value);
    if (isNaN(num)) return null;
    return num.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function statusChip(status: string): { label: string; className: string } {
    switch (status) {
        case "Decided":
            return { label: "Decided", className: "bg-green-100 text-green-700" };
        case "Flagged":
            return { label: "Needs a look", className: "bg-amber-100 text-amber-700" };
        case "Ordered":
            return { label: "Ordered", className: "bg-blue-100 text-blue-700" };
        case "Received":
            return { label: "Received", className: "bg-slate-100 text-slate-700" };
        case "Open":
        default:
            return { label: "Open", className: "bg-slate-100 text-slate-600" };
    }
}

function ApprovedItemsTable({ decisions }: { decisions: DecisionData[] }) {
    const approved = decisions
        .filter((d) => d.status === "Decided" && d.chosenItemId)
        .map((d) => ({ decision: d, item: d.candidates.find((c) => c.id === d.chosenItemId) }))
        .filter((x): x is { decision: DecisionData; item: Candidate } => !!x.item);

    return (
        <div className="hui-card mb-6">
            <div className="px-5 py-4 border-b border-hui-border">
                <h2 className="text-base font-semibold text-hui-textMain flex items-center gap-2">
                    <ClipboardList className="w-4 h-4 text-hui-primary" />
                    Approved Items
                </h2>
                <p className="text-xs text-hui-textMuted mt-0.5">The shared record of truth — what&apos;s decided and ready to buy.</p>
            </div>
            {approved.length === 0 ? (
                <p className="text-sm text-hui-textMuted text-center py-8">Nothing decided yet.</p>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b border-hui-border bg-slate-50">
                                <th className="text-left px-4 py-2.5 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Decision</th>
                                <th className="text-left px-4 py-2.5 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Chosen item</th>
                                <th className="text-left px-4 py-2.5 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Vendor</th>
                                <th className="text-right px-4 py-2.5 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">List price</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                            {approved.map(({ decision, item }) => (
                                <tr key={decision.id} className="hover:bg-slate-50 transition">
                                    <td className="px-4 py-2.5 font-medium text-hui-textMain">
                                        {decision.name}
                                        {decision.area && <span className="text-hui-textMuted font-normal"> · {decision.area}</span>}
                                    </td>
                                    <td className="px-4 py-2.5 text-hui-textMain">{item.name}</td>
                                    <td className="px-4 py-2.5">
                                        {isHttpUrl(item.vendorUrl) ? (
                                            <a href={item.vendorUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline inline-flex items-center gap-1">
                                                <ExternalLink className="w-3 h-3" />
                                                Link
                                            </a>
                                        ) : (
                                            <span className="text-hui-textMuted">—</span>
                                        )}
                                    </td>
                                    <td className="px-4 py-2.5 text-right font-semibold text-hui-textMain">
                                        {formatPrice(item.price) || "—"}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}

function CandidateCard({ item, isChosen }: { item: Candidate; isChosen: boolean }) {
    const price = formatPrice(item.price);
    return (
        <div className={`rounded-lg border p-3 ${isChosen ? "border-hui-primary ring-1 ring-hui-primary bg-hui-primary/5" : "border-slate-200"}`}>
            <div className="w-full h-28 rounded-lg bg-slate-100 flex items-center justify-center overflow-hidden">
                {isHttpUrl(item.imageUrl) ? (
                    <img src={item.imageUrl} alt={item.name} className="w-full h-full object-cover" />
                ) : (
                    <ImageOff className="w-6 h-6 text-slate-300" />
                )}
            </div>
            <div className="mt-2 flex items-start justify-between gap-2">
                <h4 className="text-sm font-semibold text-hui-textMain leading-tight">{item.name}</h4>
                {isChosen && (
                    <span className="shrink-0 inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-hui-primary bg-white rounded-full px-2 py-0.5 border border-hui-primary">
                        <CheckCircle2 className="w-3 h-3" />
                        Chosen
                    </span>
                )}
            </div>
            {price && (
                <p className="text-xs text-hui-textMuted mt-1">
                    Vendor list price: <span className="font-semibold text-hui-textMain">{price}</span>
                </p>
            )}
            {item.clientNote && <p className="text-xs text-hui-textMuted mt-1 line-clamp-2">Client note: &quot;{item.clientNote}&quot;</p>}
            {isHttpUrl(item.vendorUrl) && (
                <a href={item.vendorUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 hover:underline flex items-center gap-1 mt-1.5">
                    <ExternalLink className="w-3 h-3" />
                    View link
                </a>
            )}
        </div>
    );
}

function FlagModal({ decision, open, onClose, onFlagged }: { decision: DecisionData; open: boolean; onClose: () => void; onFlagged: () => void }) {
    const [note, setNote] = useState("");
    const [submitting, setSubmitting] = useState(false);

    function handleClose() {
        if (submitting) return;
        setNote("");
        onClose();
    }

    async function handleSubmit() {
        if (!note.trim()) {
            toast.error("A note is required so the client knows what to look at.");
            return;
        }
        setSubmitting(true);
        try {
            await flagDecision(decision.id, note.trim());
            toast.success("Flagged — the client's been emailed.");
            handleClose();
            onFlagged();
        } catch (e: any) {
            toast.error(e.message || "Couldn't flag that decision.");
        } finally {
            setSubmitting(false);
        }
    }

    if (!open) return null;

    return (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={handleClose}>
            <div className="bg-white rounded-xl shadow-2xl max-w-md w-full" onClick={(e) => e.stopPropagation()}>
                <div className="px-6 py-4 border-b border-hui-border">
                    <h3 className="text-lg font-bold text-hui-textMain">Flag &quot;{decision.name}&quot;</h3>
                    <p className="text-xs text-hui-textMuted mt-0.5">This reopens the decision — not a veto, just a note asking for another look.</p>
                </div>
                <div className="p-6">
                    <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Note to client (required)</label>
                    <textarea
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        className="hui-input w-full mt-1"
                        rows={3}
                        autoFocus
                        placeholder="e.g. This one's discontinued — can you pick another?"
                        disabled={submitting}
                    />
                </div>
                <div className="px-6 py-4 border-t border-hui-border flex justify-end gap-3 bg-slate-50 rounded-b-xl">
                    <button onClick={handleClose} disabled={submitting} className="hui-btn hui-btn-secondary">Cancel</button>
                    <button onClick={handleSubmit} disabled={submitting || !note.trim()} className="hui-btn hui-btn-primary disabled:opacity-50">
                        {submitting ? "Flagging…" : "Flag for review"}
                    </button>
                </div>
            </div>
        </div>
    );
}

function DecisionCard({
    decision,
    isFirst,
    isLast,
    onChanged,
    onMove,
}: {
    decision: DecisionData;
    isFirst: boolean;
    isLast: boolean;
    onChanged: () => void;
    onMove: (direction: "up" | "down") => void;
}) {
    const [renaming, setRenaming] = useState(false);
    const [nameDraft, setNameDraft] = useState(decision.name);
    const [savingName, setSavingName] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [addOpen, setAddOpen] = useState(false);
    const [flagOpen, setFlagOpen] = useState(false);

    const active = decision.candidates.filter((c) => c.status !== ARCHIVED);
    const chip = statusChip(decision.status);

    async function handleSaveName() {
        const trimmed = nameDraft.trim();
        if (!trimmed) {
            toast.error("Name can't be empty.");
            return;
        }
        setSavingName(true);
        try {
            await renameDecision(decision.id, trimmed);
            setRenaming(false);
            onChanged();
        } catch (e: any) {
            toast.error(e.message || "Couldn't rename that.");
        } finally {
            setSavingName(false);
        }
    }

    async function handleDelete() {
        setDeleting(true);
        try {
            await deleteDecision(decision.id);
            toast.success("Deleted — candidates moved to Unsorted.");
            setConfirmDelete(false);
            onChanged();
        } catch (e: any) {
            toast.error(e.message || "Couldn't delete that decision.");
        } finally {
            setDeleting(false);
        }
    }

    return (
        <div className="hui-card p-5">
            <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
                <div className="flex-1 min-w-[200px]">
                    {renaming ? (
                        <div className="flex items-center gap-2">
                            <input
                                type="text"
                                className="hui-input text-base font-bold py-1"
                                value={nameDraft}
                                onChange={(e) => setNameDraft(e.target.value)}
                                autoFocus
                                disabled={savingName}
                                onKeyDown={(e) => { if (e.key === "Enter") handleSaveName(); if (e.key === "Escape") { setNameDraft(decision.name); setRenaming(false); } }}
                            />
                            <button onClick={handleSaveName} disabled={savingName} className="hui-btn hui-btn-green text-xs py-1.5 px-3">Save</button>
                            <button onClick={() => { setNameDraft(decision.name); setRenaming(false); }} className="hui-btn hui-btn-secondary text-xs py-1.5 px-3">Cancel</button>
                        </div>
                    ) : (
                        <div className="flex items-center gap-2 flex-wrap">
                            <h3 className="text-lg font-bold text-hui-textMain">{decision.name}</h3>
                            {decision.area && <span className="text-xs text-hui-textMuted">· {decision.area}</span>}
                            <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${chip.className}`}>{chip.label}</span>
                            <button onClick={() => setRenaming(true)} title="Rename" aria-label="Rename decision" className="text-slate-400 hover:text-hui-textMain transition">
                                <Pencil className="w-3.5 h-3.5" />
                            </button>
                        </div>
                    )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                    {decision.status === "Decided" && (
                        <button onClick={() => setFlagOpen(true)} className="hui-btn hui-btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5">
                            <Flag className="w-3.5 h-3.5" />
                            Flag
                        </button>
                    )}
                    <button onClick={() => onMove("up")} disabled={isFirst} title="Move up" aria-label="Move decision up" className="w-7 h-7 rounded-md flex items-center justify-center text-slate-400 hover:text-hui-textMain hover:bg-slate-100 disabled:opacity-30 disabled:hover:bg-transparent transition">
                        <ArrowUp className="w-4 h-4" />
                    </button>
                    <button onClick={() => onMove("down")} disabled={isLast} title="Move down" aria-label="Move decision down" className="w-7 h-7 rounded-md flex items-center justify-center text-slate-400 hover:text-hui-textMain hover:bg-slate-100 disabled:opacity-30 disabled:hover:bg-transparent transition">
                        <ArrowDown className="w-4 h-4" />
                    </button>
                    <button onClick={() => setConfirmDelete(true)} title="Delete decision" aria-label="Delete decision" className="w-7 h-7 rounded-md flex items-center justify-center text-slate-400 hover:text-red-600 hover:bg-red-50 transition">
                        <Trash2 className="w-4 h-4" />
                    </button>
                </div>
            </div>

            {decision.status === "Flagged" && decision.pmNote && (
                <div className="mb-4 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
                    <p className="text-sm text-amber-900"><span className="font-semibold">Flag note:</span> &quot;{decision.pmNote}&quot;</p>
                </div>
            )}

            {active.length === 0 ? (
                <div className="py-6 text-center border border-dashed border-slate-200 rounded-lg">
                    <p className="text-sm text-hui-textMuted">No candidates yet.</p>
                </div>
            ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {active.map((item) => (
                        <CandidateCard key={item.id} item={item} isChosen={decision.chosenItemId === item.id} />
                    ))}
                </div>
            )}

            <div className="mt-3">
                <button onClick={() => setAddOpen(true)} className="hui-btn hui-btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5">
                    <Plus className="w-3.5 h-3.5" />
                    Add a candidate
                </button>
            </div>

            <AddCandidateModal decisionId={decision.id} decisionName={decision.name} open={addOpen} onClose={() => setAddOpen(false)} onAdded={onChanged} />
            <FlagModal decision={decision} open={flagOpen} onClose={() => setFlagOpen(false)} onFlagged={onChanged} />

            {confirmDelete && (
                <div className="fixed inset-0 bg-slate-900/50 flex items-center justify-center z-50 p-4" onClick={() => !deleting && setConfirmDelete(false)}>
                    <div className="bg-white rounded-xl shadow-xl w-full max-w-sm border border-hui-border" onClick={(e) => e.stopPropagation()}>
                        <div className="p-6">
                            <h3 className="text-base font-bold text-hui-textMain mb-2">Delete &quot;{decision.name}&quot;?</h3>
                            <p className="text-sm text-hui-textMuted">Its candidates move to Unsorted — nothing gets deleted.</p>
                        </div>
                        <div className="px-6 py-4 border-t border-hui-border flex justify-end gap-3 bg-slate-50 rounded-b-xl">
                            <button onClick={() => setConfirmDelete(false)} disabled={deleting} className="hui-btn hui-btn-secondary">Cancel</button>
                            <button onClick={handleDelete} disabled={deleting} className="hui-btn hui-btn-primary disabled:opacity-50">
                                {deleting ? "Deleting…" : "Delete"}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

function AddDecisionModal({ projectId, open, onClose, onCreated }: { projectId: string; open: boolean; onClose: () => void; onCreated: () => void }) {
    const [name, setName] = useState("");
    const [area, setArea] = useState("");
    const [creating, setCreating] = useState(false);

    function handleClose() {
        if (creating) return;
        setName("");
        setArea("");
        onClose();
    }

    async function handleCreate() {
        if (!name.trim()) {
            toast.error("Give this decision a name.");
            return;
        }
        setCreating(true);
        try {
            await createDecision(projectId, { name: name.trim(), area: area.trim() || undefined });
            toast.success("Decision added");
            setName("");
            setArea("");
            onClose();
            onCreated();
        } catch (e: any) {
            toast.error(e.message || "Couldn't add that decision.");
        } finally {
            setCreating(false);
        }
    }

    if (!open) return null;

    return (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={handleClose}>
            <div className="bg-white rounded-xl shadow-2xl max-w-sm w-full" onClick={(e) => e.stopPropagation()}>
                <div className="px-6 py-4 border-b border-hui-border">
                    <h3 className="text-lg font-bold text-hui-textMain">Add a decision</h3>
                </div>
                <div className="p-6 space-y-4">
                    <div>
                        <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Name</label>
                        <input type="text" className="hui-input w-full mt-1" placeholder="e.g. Sink Faucet" value={name} onChange={(e) => setName(e.target.value)} autoFocus disabled={creating} />
                    </div>
                    <div>
                        <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Area (optional)</label>
                        <input type="text" className="hui-input w-full mt-1" placeholder="e.g. Master Bath" value={area} onChange={(e) => setArea(e.target.value)} disabled={creating} />
                    </div>
                </div>
                <div className="px-6 py-4 border-t border-hui-border flex justify-end gap-3 bg-slate-50 rounded-b-xl">
                    <button onClick={handleClose} disabled={creating} className="hui-btn hui-btn-secondary">Cancel</button>
                    <button onClick={handleCreate} disabled={creating || !name.trim()} className="hui-btn hui-btn-green disabled:opacity-50">
                        {creating ? "Adding…" : "Add decision"}
                    </button>
                </div>
            </div>
        </div>
    );
}

export default function TeamDecisionsSection({
    projectId,
    initialDecisions,
}: {
    projectId: string;
    initialDecisions: DecisionData[];
}) {
    const router = useRouter();
    const [decisions, setDecisions] = useState<DecisionData[]>(initialDecisions);
    const [addDecisionOpen, setAddDecisionOpen] = useState(false);
    const [importing, setImporting] = useState(false);

    // initialDecisions is only the INITIAL value for useState — resync when
    // the server component re-fetches after router.refresh() (same fix
    // ClientSuggestions needed — see its comment for the bug this avoids).
    useEffect(() => {
        setDecisions(initialDecisions);
    }, [initialDecisions]);

    function refresh() {
        router.refresh();
    }

    async function handleMoveDecision(decisionId: string, direction: "up" | "down") {
        const index = decisions.findIndex((d) => d.id === decisionId);
        if (index === -1) return;
        const targetIndex = direction === "up" ? index - 1 : index + 1;
        if (targetIndex < 0 || targetIndex >= decisions.length) return;

        const reordered = [...decisions];
        [reordered[index], reordered[targetIndex]] = [reordered[targetIndex], reordered[index]];
        setDecisions(reordered);
        try {
            await reorderDecisions(projectId, reordered.map((d) => d.id));
            refresh();
        } catch (e: any) {
            toast.error(e.message || "Couldn't reorder — refreshing.");
            refresh();
        }
    }

    async function handleImport() {
        setImporting(true);
        try {
            const result = await importBoardPicksAsDecisions(projectId);
            if (result.created === 0 && result.skipped === 0) {
                toast.info("No selected board picks to import.");
            } else {
                toast.success(`Imported ${result.created}${result.skipped ? `, skipped ${result.skipped} already imported` : ""}`);
            }
            refresh();
        } catch (e: any) {
            toast.error(e.message || "Couldn't import board picks.");
        } finally {
            setImporting(false);
        }
    }

    return (
        <div>
            <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
                <div>
                    <h2 className="text-xl font-bold text-hui-textMain">Client Decisions</h2>
                    <p className="text-sm text-hui-textMuted mt-1">
                        What the client is deciding, live from their playground. Deciding is the client&apos;s call — flagging asks for another look, not a veto.
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={handleImport}
                        disabled={importing}
                        title="Safe to run anytime — never alters your boards or categories, and re-running skips anything already imported."
                        className="hui-btn hui-btn-secondary text-sm flex items-center gap-1.5 disabled:opacity-50"
                    >
                        <Download className="w-4 h-4" />
                        {importing ? "Importing…" : "Import picks from selection boards"}
                    </button>
                    <button onClick={() => setAddDecisionOpen(true)} className="hui-btn hui-btn-green text-sm flex items-center gap-1.5">
                        <Plus className="w-4 h-4" />
                        Add a decision
                    </button>
                </div>
            </div>

            <ApprovedItemsTable decisions={decisions} />

            {decisions.length === 0 ? (
                <div className="hui-card p-10 text-center">
                    <p className="text-sm text-hui-textMuted">No client decisions yet — they&apos;ll show up here as the client adds items to their playground.</p>
                </div>
            ) : (
                <div className="space-y-5">
                    {decisions.map((decision, i) => (
                        <DecisionCard
                            key={decision.id}
                            decision={decision}
                            isFirst={i === 0}
                            isLast={i === decisions.length - 1}
                            onChanged={refresh}
                            onMove={(direction) => handleMoveDecision(decision.id, direction)}
                        />
                    ))}
                </div>
            )}

            <AddDecisionModal projectId={projectId} open={addDecisionOpen} onClose={() => setAddDecisionOpen(false)} onCreated={refresh} />
        </div>
    );
}
