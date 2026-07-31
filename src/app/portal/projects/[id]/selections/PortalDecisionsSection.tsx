"use client";

// The playground — the client's primary space for this feature.
// docs/specs/client-selections-playground.md Phase 1: a Decision ("Sink
// Faucet") holds candidates; choosing one promotes it to the team's approved
// record. Siblings stay visible even after one is chosen — the runner-up
// still matters. NEVER render a price here — client-added items never carry
// one (backend strips it unconditionally, see getProjectDecisionsForPortal).

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
    createDecision,
    renameDecision,
    reorderDecisions,
    deleteDecision,
    assignItemToDecision,
    chooseItem,
    unchooseItem,
    archiveItem,
    unarchiveItem,
    deleteItem,
} from "@/lib/actions";
import { isHttpUrl } from "@/lib/url-safety";
import { buildClipperBookmarklet } from "@/lib/clipper-bookmarklet";
import ClipperDragLink from "@/components/ClipperDragLink";
import { SelectionItemNote } from "@/components/selections/SelectionItemNote";
import { SelectionItemThread, type SelectionItemThreadCommentView } from "@/components/selections/SelectionItemThread";
import AddItemModal from "./AddItemModal";
import {
    ImageOff,
    ExternalLink,
    Plus,
    X,
    Pencil,
    Trash2,
    ArrowUp,
    ArrowDown,
    CheckCircle2,
    Undo2,
    ArchiveRestore,
    ChevronDown,
    ChevronRight,
    Sparkles,
    Link2,
    Copy,
} from "lucide-react";

interface Candidate {
    id: string;
    projectId: string;
    name: string;
    description: string | null;
    imageUrl: string | null;
    vendorUrl: string | null;
    clientNote: string | null;
    status: string;
    pmNote: string | null;
    decisionId: string | null;
    createdAt: string;
    comments: SelectionItemThreadCommentView[];
    unreadThreadCount: number;
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
const TERMINAL_STATUSES = ["Ordered", "Received"];
// Sentinel for MoveToPicker's inline "＋ New category" option — a real
// decision id is a cuid, so it can never collide, and "" is already Unsorted.
const NEW_DECISION = "__new__";

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

function CandidateImage({ item }: { item: Candidate }) {
    return (
        <div className="w-full h-32 rounded-lg bg-slate-100 flex items-center justify-center overflow-hidden shrink-0">
            {isHttpUrl(item.imageUrl) ? (
                <img src={item.imageUrl} alt={item.name} className="w-full h-full object-cover" />
            ) : (
                <ImageOff className="w-6 h-6 text-slate-300" />
            )}
        </div>
    );
}

function MoveToPicker({
    item,
    decisions,
    currentDecisionId,
    currentDecisionName,
    onMoved,
}: {
    item: Candidate;
    decisions: DecisionData[];
    currentDecisionId: string | null;
    currentDecisionName?: string | null;
    onMoved: () => void;
}) {
    const [moving, setMoving] = useState(false);
    // Inline "＋ New category" so an item is never stranded: with no decisions
    // on the project yet, this select used to offer exactly one option — the
    // Unsorted the item was already in — while the card told the client to
    // "move it into a decision to choose it".
    const [creating, setCreating] = useState(false);
    const [newName, setNewName] = useState("");

    async function handleChange(value: string) {
        if (value === NEW_DECISION) {
            setCreating(true);
            return;
        }
        const targetId = value === "" ? null : value;
        if (targetId === currentDecisionId) return;
        setMoving(true);
        try {
            await assignItemToDecision(item.id, targetId);
            toast.success(targetId ? "Moved" : "Moved to Unsorted");
            onMoved();
        } catch (e: any) {
            toast.error(e.message || "Couldn't move that item.");
        } finally {
            setMoving(false);
        }
    }

    async function handleCreateAndMove() {
        const name = newName.trim();
        if (!name) return;
        setMoving(true);
        try {
            const decision = await createDecision(item.projectId, { name });
            await assignItemToDecision(item.id, decision.id);
            toast.success(`Moved into "${name}"`);
            setCreating(false);
            setNewName("");
            onMoved();
        } catch (e: any) {
            toast.error(e.message || "Couldn't create that category.");
        } finally {
            setMoving(false);
        }
    }

    // Callers (e.g. a candidate rendered inside its OWN DecisionCard) often
    // pass a `decisions` list that excludes the candidate's current decision
    // — that's the "other decisions you could move this to" set. But the
    // controlled <select>'s value is always currentDecisionId, so if that id
    // has no matching <option> the select renders blank and can look like
    // the item is Unsorted even though it isn't. Guarantee a matching option
    // exists regardless of what the caller's list contains.
    const options = currentDecisionId && !decisions.some((d) => d.id === currentDecisionId)
        ? [{ id: currentDecisionId, name: currentDecisionName || "This decision" }, ...decisions]
        : decisions;

    if (creating) {
        return (
            <div className="mt-2 flex items-center gap-1.5">
                <input
                    type="text"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") handleCreateAndMove();
                        if (e.key === "Escape") setCreating(false);
                    }}
                    placeholder="Category name"
                    className="hui-input text-xs py-1 flex-1 min-w-0"
                    disabled={moving}
                    autoFocus
                />
                <button
                    onClick={handleCreateAndMove}
                    disabled={moving || !newName.trim()}
                    className="hui-btn hui-btn-green text-xs py-1 px-2 shrink-0 disabled:opacity-50"
                >
                    {moving ? "…" : "Add"}
                </button>
                <button
                    onClick={() => { setCreating(false); setNewName(""); }}
                    disabled={moving}
                    className="text-xs text-hui-textMuted hover:text-hui-textMain shrink-0 px-1 disabled:opacity-50"
                >
                    <X className="w-3.5 h-3.5" />
                </button>
            </div>
        );
    }

    return (
        <select
            className="hui-input text-xs py-1 w-full mt-2"
            value={currentDecisionId || ""}
            onChange={(e) => handleChange(e.target.value)}
            disabled={moving}
            title="Move to…"
        >
            <option value="">Unsorted</option>
            {options.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
            ))}
            <option value={NEW_DECISION}>＋ New category…</option>
        </select>
    );
}

function CandidateCard({
    item,
    decision,
    allDecisions,
    onChanged,
}: {
    item: Candidate;
    decision: DecisionData | null;
    allDecisions: DecisionData[];
    onChanged: () => void;
}) {
    const [busy, setBusy] = useState(false);
    const isChosen = !!decision && decision.chosenItemId === item.id;
    const decisionLocked = !!decision && TERMINAL_STATUSES.includes(decision.status);

    async function handleChoose() {
        setBusy(true);
        try {
            const result = await chooseItem(item.id);
            if (!result.alreadyChosen) toast.success("That's the one — your team's been notified.");
            onChanged();
        } catch (e: any) {
            toast.error(e.message || "Couldn't choose that item.");
        } finally {
            setBusy(false);
        }
    }

    async function handleUnchoose() {
        if (!decision) return;
        setBusy(true);
        try {
            await unchooseItem(decision.id);
            toast.success("Changed your mind — no problem.");
            onChanged();
        } catch (e: any) {
            toast.error(e.message || "Couldn't change that.");
        } finally {
            setBusy(false);
        }
    }

    async function handleArchive() {
        setBusy(true);
        try {
            await archiveItem(item.id);
            toast.success("Archived");
            onChanged();
        } catch (e: any) {
            toast.error(e.message || "Couldn't archive that item.");
        } finally {
            setBusy(false);
        }
    }

    return (
        <div
            data-testid={`selection-item-${item.id}`}
            className={`relative rounded-lg border p-3 group ${
                isChosen ? "border-hui-primary ring-1 ring-hui-primary bg-hui-primary/5" : "border-slate-200"
            }`}
        >
            {!isChosen && (
                <button
                    onClick={handleArchive}
                    disabled={busy}
                    title="Archive"
                    aria-label="Archive"
                    className="absolute top-2 right-2 z-10 w-6 h-6 rounded-md bg-white/90 backdrop-blur shadow flex items-center justify-center text-slate-400 hover:text-red-600 transition opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto"
                >
                    <X className="w-3.5 h-3.5" />
                </button>
            )}

            <CandidateImage item={item} />

            <div className="mt-2 flex items-start justify-between gap-2">
                <h4 className="text-sm font-semibold text-hui-textMain leading-tight">{item.name}</h4>
                {isChosen && (
                    <span className="shrink-0 inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-hui-primary bg-white rounded-full px-2 py-0.5 border border-hui-primary">
                        <CheckCircle2 className="w-3 h-3" />
                        Chosen
                    </span>
                )}
            </div>

            <SelectionItemNote
                itemId={item.id}
                note={item.clientNote}
                onSaved={onChanged}
                className="mt-1"
            />
            <SelectionItemThread
                itemId={item.id}
                comments={item.comments}
                unreadCount={item.unreadThreadCount}
                onChanged={onChanged}
                className="mt-1.5"
            />

            {isHttpUrl(item.vendorUrl) && (
                <a
                    href={item.vendorUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-blue-600 hover:underline flex items-center gap-1 mt-1.5"
                >
                    <ExternalLink className="w-3 h-3" />
                    View link
                </a>
            )}

            <div className="mt-2.5">
                {decision ? (
                    isChosen ? (
                        !decisionLocked && (
                            <button
                                onClick={handleUnchoose}
                                disabled={busy}
                                className="hui-btn hui-btn-secondary text-xs py-1.5 px-3 w-full flex items-center justify-center gap-1.5 disabled:opacity-50"
                            >
                                <Undo2 className="w-3.5 h-3.5" />
                                Change my mind
                            </button>
                        )
                    ) : (
                        !decisionLocked && (
                            <button
                                onClick={handleChoose}
                                disabled={busy}
                                className="hui-btn hui-btn-green text-xs py-1.5 px-3 w-full disabled:opacity-50"
                            >
                                {busy ? "Choosing…" : "This is the one"}
                            </button>
                        )
                    )
                ) : (
                    <p className="text-[11px] text-hui-textMuted italic">Move into a decision to choose it.</p>
                )}
                <MoveToPicker
                    item={item}
                    decisions={allDecisions}
                    currentDecisionId={item.decisionId}
                    currentDecisionName={decision?.name}
                    onMoved={onChanged}
                />
            </div>
        </div>
    );
}

function ArchivedTray({ items, onChanged }: { items: Candidate[]; onChanged: () => void }) {
    const [open, setOpen] = useState(false);
    const [busyId, setBusyId] = useState<string | null>(null);
    // Two-step inline confirm rather than window.confirm() — delete is
    // recoverable (soft delete, see deleteItem) so a modal is overkill, and a
    // native confirm() dialog blocks the page for anything driving this
    // headlessly.
    const [confirmingId, setConfirmingId] = useState<string | null>(null);

    if (items.length === 0) return null;

    async function handleUnarchive(id: string) {
        setBusyId(id);
        try {
            await unarchiveItem(id);
            toast.success("Brought it back");
            onChanged();
        } catch (e: any) {
            toast.error(e.message || "Couldn't unarchive that item.");
        } finally {
            setBusyId(null);
        }
    }

    async function handleDelete(id: string) {
        setBusyId(id);
        try {
            await deleteItem(id);
            toast.success("Deleted");
            setConfirmingId(null);
            onChanged();
        } catch (e: any) {
            toast.error(e.message || "Couldn't delete that item.");
        } finally {
            setBusyId(null);
        }
    }

    return (
        <div className="mt-3 border-t border-slate-100 pt-2">
            <button
                onClick={() => setOpen((v) => !v)}
                className="text-xs font-medium text-hui-textMuted hover:text-hui-textMain flex items-center gap-1"
            >
                {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                Archived ({items.length})
            </button>
            {open && (
                <div className="mt-2 space-y-1.5">
                    {items.map((item) => (
                        <div key={item.id} className="flex items-center justify-between gap-2 text-xs bg-slate-50 rounded-md px-2.5 py-1.5">
                            <span className="text-hui-textMuted truncate">{item.name}</span>
                            {confirmingId === item.id ? (
                                <span className="shrink-0 flex items-center gap-2">
                                    <button
                                        onClick={() => handleDelete(item.id)}
                                        disabled={busyId === item.id}
                                        className="text-red-600 font-medium hover:underline disabled:opacity-50"
                                    >
                                        {busyId === item.id ? "Deleting…" : "Delete for good"}
                                    </button>
                                    <button
                                        onClick={() => setConfirmingId(null)}
                                        disabled={busyId === item.id}
                                        className="text-hui-textMuted hover:underline disabled:opacity-50"
                                    >
                                        Cancel
                                    </button>
                                </span>
                            ) : (
                                <span className="shrink-0 flex items-center gap-2.5">
                                    <button
                                        onClick={() => handleUnarchive(item.id)}
                                        disabled={busyId === item.id}
                                        className="text-hui-primary hover:underline flex items-center gap-1 disabled:opacity-50"
                                    >
                                        <ArchiveRestore className="w-3 h-3" />
                                        Unarchive
                                    </button>
                                    <button
                                        onClick={() => setConfirmingId(item.id)}
                                        disabled={busyId === item.id}
                                        title="Delete this item"
                                        className="text-hui-textMuted hover:text-red-600 flex items-center gap-1 disabled:opacity-50"
                                    >
                                        <Trash2 className="w-3 h-3" />
                                        Delete
                                    </button>
                                </span>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

function DecisionCard({
    decision,
    allDecisions,
    isFirst,
    isLast,
    reordering,
    projectId,
    onChanged,
    onMove,
}: {
    decision: DecisionData;
    allDecisions: DecisionData[];
    isFirst: boolean;
    isLast: boolean;
    reordering: boolean;
    projectId: string;
    onChanged: () => void;
    onMove: (direction: "up" | "down") => void;
}) {
    const [renaming, setRenaming] = useState(false);
    const [nameDraft, setNameDraft] = useState(decision.name);
    const [savingName, setSavingName] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [addOpen, setAddOpen] = useState(false);

    const active = decision.candidates.filter((c) => c.status !== ARCHIVED);
    const archived = decision.candidates.filter((c) => c.status === ARCHIVED);
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
                            <button onClick={handleSaveName} disabled={savingName} className="hui-btn hui-btn-green text-xs py-1.5 px-3">
                                Save
                            </button>
                            <button onClick={() => { setNameDraft(decision.name); setRenaming(false); }} className="hui-btn hui-btn-secondary text-xs py-1.5 px-3">
                                Cancel
                            </button>
                        </div>
                    ) : (
                        <div className="flex items-center gap-2 flex-wrap">
                            <h3 className="text-lg font-bold text-hui-textMain">{decision.name}</h3>
                            {decision.area && <span className="text-xs text-hui-textMuted">· {decision.area}</span>}
                            <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${chip.className}`}>
                                {chip.label}
                            </span>
                            <button
                                onClick={() => setRenaming(true)}
                                title="Rename"
                                aria-label="Rename decision"
                                className="text-slate-400 hover:text-hui-textMain transition"
                            >
                                <Pencil className="w-3.5 h-3.5" />
                            </button>
                        </div>
                    )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                    <button
                        onClick={() => onMove("up")}
                        disabled={isFirst || reordering}
                        title="Move up"
                        aria-label="Move decision up"
                        className="w-7 h-7 rounded-md flex items-center justify-center text-slate-400 hover:text-hui-textMain hover:bg-slate-100 disabled:opacity-30 disabled:hover:bg-transparent transition"
                    >
                        <ArrowUp className="w-4 h-4" />
                    </button>
                    <button
                        onClick={() => onMove("down")}
                        disabled={isLast || reordering}
                        title="Move down"
                        aria-label="Move decision down"
                        className="w-7 h-7 rounded-md flex items-center justify-center text-slate-400 hover:text-hui-textMain hover:bg-slate-100 disabled:opacity-30 disabled:hover:bg-transparent transition"
                    >
                        <ArrowDown className="w-4 h-4" />
                    </button>
                    <button
                        onClick={() => setConfirmDelete(true)}
                        title="Delete decision"
                        aria-label="Delete decision"
                        className="w-7 h-7 rounded-md flex items-center justify-center text-slate-400 hover:text-red-600 hover:bg-red-50 transition"
                    >
                        <Trash2 className="w-4 h-4" />
                    </button>
                </div>
            </div>

            {decision.status === "Flagged" && decision.pmNote && (
                <div className="mb-4 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
                    <p className="text-sm text-amber-900">
                        <span className="font-semibold">Your project team had a note about this one:</span>{" "}
                        &quot;{decision.pmNote}&quot;
                    </p>
                    <p className="text-xs text-amber-700 mt-1">Take another look below and choose again whenever you&apos;re ready.</p>
                </div>
            )}

            {active.length === 0 ? (
                <div className="py-6 text-center border border-dashed border-slate-200 rounded-lg">
                    <p className="text-sm text-hui-textMuted">No candidates yet — add one to get started.</p>
                </div>
            ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {active.map((item) => (
                        <CandidateCard
                            key={item.id}
                            item={item}
                            decision={decision}
                            allDecisions={allDecisions}
                            onChanged={onChanged}
                        />
                    ))}
                </div>
            )}

            <div className="mt-3">
                <button
                    onClick={() => setAddOpen(true)}
                    className="hui-btn hui-btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5"
                >
                    <Plus className="w-3.5 h-3.5" />
                    Add an item
                </button>
            </div>

            <ArchivedTray items={archived} onChanged={onChanged} />

            <AddItemModal
                projectId={projectId}
                decisionId={decision.id}
                decisionName={decision.name}
                open={addOpen}
                onClose={() => setAddOpen(false)}
                onSubmitted={onChanged}
            />

            {confirmDelete && (
                <div className="fixed inset-0 bg-slate-900/50 flex items-center justify-center z-50 p-4" onClick={() => !deleting && setConfirmDelete(false)}>
                    <div className="bg-white rounded-xl shadow-xl w-full max-w-sm border border-hui-border" onClick={(e) => e.stopPropagation()}>
                        <div className="p-6">
                            <h3 className="text-base font-bold text-hui-textMain mb-2">Delete &quot;{decision.name}&quot;?</h3>
                            <p className="text-sm text-hui-textMuted">
                                Its candidates move to Unsorted — nothing gets deleted.
                            </p>
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

function AddDecisionModal({
    projectId,
    open,
    onClose,
    onCreated,
}: {
    projectId: string;
    open: boolean;
    onClose: () => void;
    onCreated: () => void;
}) {
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
        <div className="fixed inset-0 bg-slate-900/50 flex items-center justify-center z-50 p-4" onClick={handleClose}>
            <div className="bg-white rounded-xl shadow-xl w-full max-w-sm border border-hui-border" onClick={(e) => e.stopPropagation()}>
                <div className="px-6 py-4 border-b border-hui-border">
                    <h3 className="text-base font-bold text-hui-textMain">Add a decision</h3>
                    <p className="text-xs text-hui-textMuted mt-0.5">A thing you need to pick — like &quot;Sink Faucet&quot;.</p>
                </div>
                <div className="p-6 space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-hui-textMain mb-1">Name</label>
                        <input
                            type="text"
                            className="hui-input"
                            placeholder="e.g. Sink Faucet"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            autoFocus
                            disabled={creating}
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-hui-textMain mb-1">
                            Area <span className="text-hui-textMuted font-normal">(optional)</span>
                        </label>
                        <input
                            type="text"
                            className="hui-input"
                            placeholder="e.g. Master Bath"
                            value={area}
                            onChange={(e) => setArea(e.target.value)}
                            disabled={creating}
                        />
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

export default function PortalDecisionsSection({
    projectId,
    appUrl,
    initialDecisions,
    initialUnsorted,
}: {
    projectId: string;
    appUrl: string;
    initialDecisions: DecisionData[];
    initialUnsorted: Candidate[];
}) {
    const router = useRouter();
    const [decisions, setDecisions] = useState<DecisionData[]>(initialDecisions);
    const [unsorted, setUnsorted] = useState<Candidate[]>(initialUnsorted);
    const [addDecisionOpen, setAddDecisionOpen] = useState(false);
    const [addUnsortedOpen, setAddUnsortedOpen] = useState(false);
    const [reordering, setReordering] = useState(false);
    // Collapsed by default and session-local — the setup blurb is a one-time
    // read that otherwise pushes actual selections below the fold on every
    // visit, but it resets closed on reload rather than persisting so a
    // client who forgets how they left it always gets the compact view back.
    const [clipperOpen, setClipperOpen] = useState(false);

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

    // initialDecisions/initialUnsorted are only the INITIAL values for
    // useState — resync whenever the server component re-fetches after
    // router.refresh(), otherwise local state goes stale (see ClientSuggestions
    // for the earlier bug this pattern fixes).
    useEffect(() => {
        setDecisions(initialDecisions);
    }, [initialDecisions]);
    useEffect(() => {
        setUnsorted(initialUnsorted);
    }, [initialUnsorted]);

    function refresh() {
        router.refresh();
    }

    const activeUnsorted = unsorted.filter((c) => c.status !== ARCHIVED);
    const archivedUnsorted = unsorted.filter((c) => c.status === ARCHIVED);

    async function handleMoveDecision(decisionId: string, direction: "up" | "down") {
        const index = decisions.findIndex((d) => d.id === decisionId);
        if (index === -1) return;
        const targetIndex = direction === "up" ? index - 1 : index + 1;
        if (targetIndex < 0 || targetIndex >= decisions.length) return;

        const reordered = [...decisions];
        [reordered[index], reordered[targetIndex]] = [reordered[targetIndex], reordered[index]];
        setDecisions(reordered);
        setReordering(true);
        try {
            await reorderDecisions(projectId, reordered.map((d) => d.id));
            refresh();
        } catch (e: any) {
            toast.error(e.message || "Couldn't reorder — refreshing.");
            refresh();
        } finally {
            setReordering(false);
        }
    }

    const isEmpty = decisions.length === 0 && unsorted.length === 0;

    return (
        <div>
            <div className="hui-card p-5 mb-6">
                <div className={`flex items-center justify-between gap-6 flex-wrap ${clipperOpen ? "pb-4 border-b border-hui-border" : "pb-3 border-b border-hui-border"}`}>
                    <div className="flex items-center gap-4 min-w-0">
                        <div className="w-11 h-11 bg-hui-primary/10 rounded-xl flex items-center justify-center shrink-0">
                            <Link2 className="w-5 h-5 text-hui-primary" />
                        </div>
                        <div className="min-w-0">
                            <button
                                type="button"
                                onClick={() => setClipperOpen((v) => !v)}
                                aria-expanded={clipperOpen}
                                aria-controls="portal-clipper-content"
                                className="text-base font-semibold text-hui-textMain flex items-center gap-1 hover:text-hui-primary transition"
                            >
                                {clipperOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                                Get the Clipper
                            </button>
                            {clipperOpen ? (
                                <p className="text-sm text-hui-textMuted mt-0.5 max-w-md">
                                    Found something while shopping? Drag the ProBuild Clip button to your bookmarks bar.
                                    <br />
                                    On any product page, click it and the item lands right here for you to sort.
                                    <br />
                                    Dragging not working on your device? Tap Copy, then make a new bookmark and paste it in as the URL.
                                </p>
                            ) : (
                                <p className="text-xs text-hui-textMuted mt-0.5 ml-5">Clip items straight from any store page.</p>
                            )}
                        </div>
                    </div>
                    {clipperOpen && (
                        <div id="portal-clipper-content" className="flex items-center gap-2 shrink-0">
                            <ClipperDragLink
                                href={bookmarkletHref}
                                className="hui-btn hui-btn-secondary flex items-center gap-2 cursor-grab active:cursor-grabbing"
                                title="Drag ProBuild Clip to your bookmarks bar"
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
                    )}
                </div>
                <div className="flex items-center justify-between gap-3 flex-wrap pt-4">
                    <div>
                        <h2 className="text-xl font-bold text-hui-textMain">Your Selections</h2>
                        <p className="text-sm text-hui-textMuted">
                            Explore your options here, and let us know when you&apos;ve landed on one.
                        </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                        <button onClick={() => setAddUnsortedOpen(true)} className="hui-btn hui-btn-secondary flex items-center gap-1.5">
                            <Plus className="w-4 h-4" />
                            Add an item
                        </button>
                        <button onClick={() => setAddDecisionOpen(true)} className="hui-btn hui-btn-green flex items-center gap-1.5">
                            <Plus className="w-4 h-4" />
                            Add a decision
                        </button>
                    </div>
                </div>
            </div>

            {isEmpty ? (
                <div className="hui-card">
                    <div className="flex flex-col items-center justify-center py-16 text-center px-6">
                        <div className="w-16 h-16 bg-hui-primary/10 rounded-2xl flex items-center justify-center mb-4">
                            <Sparkles className="w-7 h-7 text-hui-primary" />
                        </div>
                        <h3 className="text-base font-semibold text-hui-textMain">This is your space</h3>
                        <p className="text-sm text-hui-textMuted mt-1 max-w-md">
                            Start a decision for anything you&apos;re picking out — a faucet, a tile, a light fixture — and drop in the options you&apos;re torn between. When you land on one, tell us and we&apos;ll take it from there.
                        </p>
                        <div className="flex items-center gap-2 mt-4">
                            <button onClick={() => setAddDecisionOpen(true)} className="hui-btn hui-btn-green flex items-center gap-1.5">
                                <Plus className="w-4 h-4" />
                                Start a decision
                            </button>
                            <button onClick={() => setAddUnsortedOpen(true)} className="hui-btn hui-btn-secondary flex items-center gap-1.5">
                                <Plus className="w-4 h-4" />
                                Just add an item
                            </button>
                        </div>
                    </div>
                </div>
            ) : (
                <div className="space-y-5">
                    {/* Unsorted sits ABOVE the decisions, not below: it's the
                        inbox for anything just clipped, so it's the one block
                        that needs acting on. Burying it under a long list of
                        decisions meant new clips went unnoticed. */}
                    {(activeUnsorted.length > 0 || archivedUnsorted.length > 0) && (
                        <div className="hui-card p-5">
                            <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                                <div>
                                    <h3 className="text-base font-semibold text-hui-textMain">Unsorted</h3>
                                    <p className="text-xs text-hui-textMuted mt-0.5">
                                        Items that aren&apos;t part of a decision yet — move them into one to choose.
                                    </p>
                                </div>
                                <button
                                    onClick={() => setAddUnsortedOpen(true)}
                                    className="hui-btn hui-btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5"
                                >
                                    <Plus className="w-3.5 h-3.5" />
                                    Add an item
                                </button>
                            </div>

                            {activeUnsorted.length === 0 ? (
                                <p className="text-sm text-hui-textMuted py-4 text-center">Nothing unsorted right now.</p>
                            ) : (
                                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                                    {activeUnsorted.map((item) => (
                                        <CandidateCard
                                            key={item.id}
                                            item={item}
                                            decision={null}
                                            allDecisions={decisions}
                                            onChanged={refresh}
                                        />
                                    ))}
                                </div>
                            )}

                            <ArchivedTray items={archivedUnsorted} onChanged={refresh} />
                        </div>
                    )}

                    {decisions.map((decision, i) => (
                        <DecisionCard
                            key={decision.id}
                            decision={decision}
                            allDecisions={decisions.filter((d) => d.id !== decision.id)}
                            isFirst={i === 0}
                            isLast={i === decisions.length - 1}
                            reordering={reordering}
                            projectId={projectId}
                            onChanged={refresh}
                            onMove={(direction) => handleMoveDecision(decision.id, direction)}
                        />
                    ))}
                </div>
            )}

            <AddDecisionModal
                projectId={projectId}
                open={addDecisionOpen}
                onClose={() => setAddDecisionOpen(false)}
                onCreated={refresh}
            />
            <AddItemModal
                projectId={projectId}
                open={addUnsortedOpen}
                onClose={() => setAddUnsortedOpen(false)}
                onSubmitted={refresh}
            />
        </div>
    );
}
