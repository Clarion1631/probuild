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
    applySuggestedDecision,
    dismissSelectionSuggestion,
} from "@/lib/actions";
import { isHttpUrl } from "@/lib/url-safety";
import { SelectionItemNote } from "@/components/selections/SelectionItemNote";
import { SelectionItemThread, type SelectionItemThreadCommentView } from "@/components/selections/SelectionItemThread";
import AddCandidateModal from "./AddCandidateModal";
import RecentlyDeletedDecisions from "./RecentlyDeletedDecisions";
import AiSortReviewModal, { type AiSortSuggestionRow } from "./AiSortReviewModal";
import LinkScheduleReviewModal, { type LinkScheduleSuggestionRow } from "./LinkScheduleReviewModal";
import ApplyTemplateModal from "./ApplyTemplateModal";
import DecisionDueDateEditPopover, { type ProjectScheduleTaskOption } from "./DecisionDueDateEditPopover";
import DecisionOrderPopover from "./DecisionOrderPopover";
import { dueDateUrgency, formatDueDateShort } from "@/lib/decision-due-date";
import { formatDeliveryRiskWording } from "@/lib/selection-order-risk";
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
    Sparkles,
    Check,
    X,
    Calendar,
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
    comments: SelectionItemThreadCommentView[];
    unreadThreadCount: number;
    // AI Auto-Sort (docs/superpowers/plans/2026-07-30-selection-ai-sort.md) —
    // resolved to a chip only when it still matches a live decision (see
    // resolveSuggestion below); staff-only, never present on portal reads.
    suggestedDecisionId: string | null;
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
    // Schedule-driven due dates (Phase 3) — raw link/override fields (staff
    // read only; the portal read strips these) plus the computed value.
    scheduleTaskId: string | null;
    leadTimeDays: number | null;
    dueDate: string | null;
    effectiveDueDate: string | null;
    // Staff-only display state (Codex review round 1, issue 7) — never sent
    // to the portal.
    isManual: boolean;
    linkState: "linked" | "dangling" | "none";
    // Order tracking + delivery risk (Phase 4) — raw fields (staff read
    // only; the portal read strips these to orderStatusForPortal) plus the
    // computed risk.
    orderedAt: string | null;
    orderedBy: string | null;
    expectedArrivalAt: string | null;
    risk: { level: "late" | "tight" | null; referenceDate: string | null; daysLate: number | null };
}

interface DeletedDecision {
    id: string;
    name: string;
    area: string | null;
    deletedAt: string;
    candidates: { id: string }[];
}

interface DeletedItem {
    id: string;
    name: string;
    deletedAt: string;
    decision: { id: string; name: string } | null;
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

// Undecided-only urgency badge (Open/Flagged) — Decided/Ordered/Received
// show nothing regardless of effectiveDueDate (Phase 3 —
// docs/superpowers/plans/2026-07-31-selection-templates-due-dates.md). A
// small "manual" marker appears when the date came from the ADMIN/MANAGER
// override rather than schedule derivation (Codex review round 1, issue 7)
// — otherwise a manually-set date is visually indistinguishable from a
// derived one.
function DecideByBadge({
    status,
    effectiveDueDate,
    isManual,
}: {
    status: string;
    effectiveDueDate: string | null;
    isManual: boolean;
}) {
    if (status !== "Open" && status !== "Flagged") return null;
    if (!effectiveDueDate) return null;
    const date = new Date(effectiveDueDate);
    const urgency = dueDateUrgency(date);
    return (
        <span data-testid="decide-by-badge" className="inline-flex items-center gap-1 text-xs">
            <span className="text-hui-textMuted">Decide by {formatDueDateShort(date)}</span>
            {isManual && (
                <span data-testid="decide-by-manual-marker" title="Manually set — always wins over the schedule link" className="px-1.5 py-0.5 rounded-full font-medium bg-blue-100 text-blue-700">
                    manual
                </span>
            )}
            {urgency && (
                <span className={`px-1.5 py-0.5 rounded-full font-medium ${urgency.className}`}>{urgency.label}</span>
            )}
        </span>
    );
}

// The shared record of truth stays visible through the rest of the order
// lifecycle (Phase 4 cross-cutting correction) — marking a decision Ordered
// (or Received) must NOT vanish it from Approved Items, only Decided did
// before this widened.
const APPROVED_STATUSES = ["Decided", "Ordered", "Received"];

// Read-only "Ordered <date> by <who> · arrives ~<eta>" / "Received" history
// line (Phase 4) — Ordered/Received only, gates itself so callers don't need
// a status check. Codex review round 1, issue 4: orderedBy is nullable
// (legacy/edge-case rows) — NEVER invent attribution. Each segment (who,
// order date) only renders when its underlying field is actually present;
// with both absent this degrades gracefully to a bare "Ordered"/"Received".
function OrderStatusLine({ decision }: { decision: DecisionData }) {
    if (decision.status !== "Ordered" && decision.status !== "Received") return null;
    const orderedDateLabel = decision.orderedAt ? formatDueDateShort(new Date(decision.orderedAt)) : null;
    const whoLabel = decision.orderedBy === "CLIENT" ? "Client" : decision.orderedBy === "TEAM" ? "GTR team" : null;
    const etaLabel = decision.expectedArrivalAt ? formatDueDateShort(new Date(decision.expectedArrivalAt)) : null;

    let orderedSegment = "Ordered";
    if (orderedDateLabel) orderedSegment += ` ${orderedDateLabel}`;
    if (whoLabel) orderedSegment += ` by ${whoLabel}`;

    if (decision.status === "Received") {
        const hasOrderedInfo = !!orderedDateLabel || !!whoLabel;
        return (
            <span data-testid={`order-status-line-${decision.id}`} className="text-xs text-hui-textMuted">
                {hasOrderedInfo ? `${orderedSegment} · ` : ""}Received
            </span>
        );
    }

    return (
        <span data-testid={`order-status-line-${decision.id}`} className="text-xs text-hui-textMuted">
            {orderedSegment}
            {etaLabel ? ` · arrives ~${etaLabel}` : ""}
        </span>
    );
}

// Delivery-risk badge (Phase 4) — red "late" / amber "tight", derived from
// assessDeliveryRisk via the staff loader's attached `risk`. Null level
// renders nothing. Wording built by the shared formatDeliveryRiskWording
// (selection-order-risk.ts) — Codex review round 1, issue 5's zero-day
// special case lives there once, not duplicated per call site.
function RiskBadge({ decisionId, risk }: { decisionId: string; risk: DecisionData["risk"] }) {
    if (!risk.level) return null;
    const className = risk.level === "late" ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700";
    return (
        <span data-testid={`risk-badge-${decisionId}`} className={`px-1.5 py-0.5 rounded-full font-medium text-xs ${className}`}>
            {formatDeliveryRiskWording(risk)}
        </span>
    );
}

// Banner above Approved Items, only rendered when at least one decision is
// at risk — red items listed before amber, each an anchor jump-link to its
// decision card.
function RiskBanner({ decisions }: { decisions: DecisionData[] }) {
    const risky = decisions.filter((d): d is DecisionData & { risk: { level: "late" | "tight"; referenceDate: string | null; daysLate: number } } => !!d.risk.level);
    if (risky.length === 0) return null;

    const sorted = [...risky].sort((a, b) => {
        if (a.risk.level === b.risk.level) return 0;
        return a.risk.level === "late" ? -1 : 1;
    });

    return (
        <div data-testid="order-risk-banner" className="hui-card mb-6 border-amber-200 bg-amber-50">
            <div className="px-5 py-4">
                <h3 className="text-sm font-semibold text-amber-900">
                    {sorted.length} item{sorted.length === 1 ? "" : "s"} may delay the schedule
                </h3>
                <ul className="mt-2 space-y-1">
                    {sorted.map((decision) => (
                        <li key={decision.id} data-testid={`order-risk-banner-item-${decision.id}`} className="text-sm">
                            <a
                                href={`#decision-${decision.id}`}
                                className={`hover:underline ${decision.risk.level === "late" ? "text-red-700" : "text-amber-700"}`}
                            >
                                {decision.name} — {formatDeliveryRiskWording(decision.risk)}
                            </a>
                        </li>
                    ))}
                </ul>
            </div>
        </div>
    );
}

function ApprovedItemsTable({
    decisions,
    onChanged,
}: {
    decisions: DecisionData[];
    onChanged: () => void;
}) {
    const approved = decisions
        .filter((d) => APPROVED_STATUSES.includes(d.status) && d.chosenItemId)
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
                                <th className="text-left px-4 py-2.5 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Notes</th>
                                <th className="text-left px-4 py-2.5 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Vendor</th>
                                <th className="text-right px-4 py-2.5 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">List price</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                            {approved.map(({ decision, item }) => (
                                <tr
                                    key={decision.id}
                                    data-testid={`approved-item-${item.id}`}
                                    className="hover:bg-slate-50 transition"
                                >
                                    <td className="px-4 py-2.5 font-medium text-hui-textMain">
                                        {decision.name}
                                        {decision.area && <span className="text-hui-textMuted font-normal"> · {decision.area}</span>}
                                    </td>
                                    <td className="px-4 py-2.5 text-hui-textMain">{item.name}</td>
                                    <td className="px-4 py-2.5 min-w-[220px]">
                                        <SelectionItemNote
                                            itemId={item.id}
                                            note={item.clientNote}
                                            onSaved={onChanged}
                                        />
                                        <SelectionItemThread
                                            itemId={item.id}
                                            instanceId={`approved-${item.id}`}
                                            comments={item.comments}
                                            unreadCount={item.unreadThreadCount}
                                            onChanged={onChanged}
                                            className="mt-1.5"
                                        />
                                    </td>
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

function CandidateCard({
    item,
    isChosen,
    onChanged,
    suggestion,
}: {
    item: Candidate;
    isChosen: boolean;
    onChanged: () => void;
    // Only ever passed for Unsorted cards — decisions inside a DecisionCard
    // never show a chip (manually filed items are never touched).
    suggestion?: { decisionId: string; decisionName: string } | null;
}) {
    const price = formatPrice(item.price);
    const [suggestionBusy, setSuggestionBusy] = useState<"apply" | "dismiss" | null>(null);

    async function handleApplySuggestion() {
        if (!suggestion) return;
        setSuggestionBusy("apply");
        try {
            const result = await applySuggestedDecision(item.id, suggestion.decisionId);
            if (result.applied) {
                toast.success(`Sorted into ${suggestion.decisionName}`);
            } else {
                toast.info("That item changed since the suggestion was made — refresh to see its current state.");
            }
            onChanged();
        } catch (e: any) {
            toast.error(e.message || "Couldn't apply that suggestion.");
        } finally {
            setSuggestionBusy(null);
        }
    }

    async function handleDismissSuggestion() {
        setSuggestionBusy("dismiss");
        try {
            await dismissSelectionSuggestion(item.id);
            onChanged();
        } catch (e: any) {
            toast.error(e.message || "Couldn't dismiss that suggestion.");
        } finally {
            setSuggestionBusy(null);
        }
    }

    return (
        <div
            data-testid={`selection-item-${item.id}`}
            className={`rounded-lg border p-3 ${isChosen ? "border-hui-primary ring-1 ring-hui-primary bg-hui-primary/5" : "border-slate-200"}`}
        >
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
            {suggestion && (
                <div
                    data-testid={`selection-suggestion-chip-${item.id}`}
                    className="mt-1.5 inline-flex items-center gap-1.5 text-xs bg-hui-primary/10 text-hui-primary rounded-full pl-2 pr-1 py-0.5"
                >
                    <Sparkles className="w-3 h-3 shrink-0" />
                    <span className="truncate max-w-[140px]">AI: {suggestion.decisionName}</span>
                    <button
                        type="button"
                        data-testid={`selection-suggestion-apply-${item.id}`}
                        onClick={handleApplySuggestion}
                        disabled={suggestionBusy !== null}
                        title={`Sort into ${suggestion.decisionName}`}
                        aria-label={`Apply AI suggestion: sort into ${suggestion.decisionName}`}
                        // Affirmative action — filled green, not just a subtle
                        // hover tint, so it reads as "apply" at a glance.
                        className="w-5 h-5 rounded-full flex items-center justify-center bg-hui-primary text-white hover:bg-hui-primaryHover disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-hui-primary focus-visible:ring-offset-1"
                    >
                        <Check className="w-3 h-3" />
                    </button>
                    <button
                        type="button"
                        data-testid={`selection-suggestion-dismiss-${item.id}`}
                        onClick={handleDismissSuggestion}
                        disabled={suggestionBusy !== null}
                        title="Dismiss suggestion"
                        aria-label="Dismiss AI suggestion"
                        // Dismiss stays subtle (unfilled) but with a clearly
                        // visible hover/focus state, distinct from apply.
                        className="w-5 h-5 rounded-full flex items-center justify-center text-hui-textMuted hover:bg-red-50 hover:text-red-600 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-1"
                    >
                        <X className="w-3 h-3" />
                    </button>
                </div>
            )}
            {/* One inline row for the small actions; a saved note or an active
                thread takes its own full-width line so text stays readable. */}
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                <SelectionItemNote
                    itemId={item.id}
                    note={item.clientNote}
                    onSaved={onChanged}
                    className={item.clientNote?.trim() ? "basis-full" : ""}
                />
                <SelectionItemThread
                    itemId={item.id}
                    comments={item.comments}
                    unreadCount={item.unreadThreadCount}
                    onChanged={onChanged}
                    className={item.comments.length > 0 ? "basis-full" : ""}
                />
                {isHttpUrl(item.vendorUrl) && (
                    <a href={item.vendorUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 hover:underline flex items-center gap-1">
                        <ExternalLink className="w-3 h-3" />
                        View link
                    </a>
                )}
            </div>
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
    isAdminOrManager,
    scheduleTasks,
}: {
    decision: DecisionData;
    isFirst: boolean;
    isLast: boolean;
    onChanged: () => void;
    onMove: (direction: "up" | "down") => void;
    isAdminOrManager: boolean;
    scheduleTasks: ProjectScheduleTaskOption[];
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
        <div id={`decision-${decision.id}`} className="hui-card p-5">
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
                            <button onClick={() => setRenaming(true)} title="Rename" aria-label="Edit decision title" className="text-slate-400 hover:text-hui-textMain transition">
                                <Pencil className="w-3.5 h-3.5" />
                            </button>
                            <DecideByBadge status={decision.status} effectiveDueDate={decision.effectiveDueDate} isManual={decision.isManual} />
                            <DecisionDueDateEditPopover
                                decisionId={decision.id}
                                decisionName={decision.name}
                                scheduleTaskId={decision.scheduleTaskId}
                                leadTimeDays={decision.leadTimeDays}
                                dueDate={decision.dueDate}
                                linkState={decision.linkState}
                                tasks={scheduleTasks}
                                isAdminOrManager={isAdminOrManager}
                                onSaved={onChanged}
                            />
                            <OrderStatusLine decision={decision} />
                            <RiskBadge decisionId={decision.id} risk={decision.risk} />
                            <DecisionOrderPopover
                                decisionId={decision.id}
                                decisionName={decision.name}
                                status={decision.status}
                                orderedAt={decision.orderedAt}
                                orderedBy={decision.orderedBy}
                                expectedArrivalAt={decision.expectedArrivalAt}
                                onSaved={onChanged}
                            />
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
                        <CandidateCard key={item.id} item={item} isChosen={decision.chosenItemId === item.id} onChanged={onChanged} />
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
    initialUnsorted,
    initialRecentlyDeleted,
    initialRecentlyDeletedItems,
    isAdminOrManager,
    scheduleTasks,
}: {
    projectId: string;
    initialDecisions: DecisionData[];
    initialUnsorted: Candidate[];
    initialRecentlyDeleted: DeletedDecision[];
    initialRecentlyDeletedItems: DeletedItem[];
    isAdminOrManager: boolean;
    scheduleTasks: ProjectScheduleTaskOption[];
}) {
    const router = useRouter();
    const [decisions, setDecisions] = useState<DecisionData[]>(initialDecisions);
    const [unsorted, setUnsorted] = useState<Candidate[]>(initialUnsorted);
    const [addDecisionOpen, setAddDecisionOpen] = useState(false);
    const [importing, setImporting] = useState(false);
    const [sorting, setSorting] = useState(false);
    const [aiSortRows, setAiSortRows] = useState<AiSortSuggestionRow[]>([]);
    // The live decisions list for the review modal's selects comes straight
    // from the ai-sort response, NOT the page's own `decisions` state — the
    // route already re-queried live decisions in the same request that
    // produced the suggestions, so the modal never has to join fresh
    // suggestions against this component's possibly-stale snapshot.
    const [aiSortDecisions, setAiSortDecisions] = useState<{ id: string; name: string }[]>([]);
    const [aiSortFailedCount, setAiSortFailedCount] = useState(0);
    const [aiSortModalOpen, setAiSortModalOpen] = useState(false);

    const [linking, setLinking] = useState(false);
    const [linkScheduleRows, setLinkScheduleRows] = useState<LinkScheduleSuggestionRow[]>([]);
    const [linkScheduleTasks, setLinkScheduleTasks] = useState<{ id: string; name: string; startDate: string }[]>([]);
    const [linkScheduleFailedCount, setLinkScheduleFailedCount] = useState(0);
    const [linkScheduleModalOpen, setLinkScheduleModalOpen] = useState(false);

    // initialDecisions is only the INITIAL value for useState — resync when
    // the server component re-fetches after router.refresh() (same fix
    // ClientSuggestions needed — see its comment for the bug this avoids).
    useEffect(() => {
        setDecisions(initialDecisions);
    }, [initialDecisions]);
    useEffect(() => {
        setUnsorted(initialUnsorted);
    }, [initialUnsorted]);

    // Archived unsorted items stay out of the team's way — the client parked
    // them deliberately, and they're still one click from restoration on the
    // client side.
    const activeUnsorted = unsorted.filter((c) => c.status !== ARCHIVED);

    // Live decisions only — a chip resolves to a decision id/name from THIS
    // list, so a stale/deleted suggestedDecisionId (a decision renamed or
    // deleted since the suggestion was computed) naturally renders no chip
    // rather than needing a separate staleness check.
    const liveDecisionsById = new Map(decisions.map((d) => [d.id, d.name]));
    function resolveSuggestion(item: Candidate): { decisionId: string; decisionName: string } | null {
        if (!item.suggestedDecisionId) return null;
        const decisionName = liveDecisionsById.get(item.suggestedDecisionId);
        return decisionName ? { decisionId: item.suggestedDecisionId, decisionName } : null;
    }

    function refresh() {
        router.refresh();
    }

    async function handleSortWithAi() {
        setSorting(true);
        try {
            const res = await fetch("/api/selections/ai-sort", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ projectId }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(body.error || "Couldn't get AI suggestions.");
            }

            // The route response already carries everything the modal
            // renders (item name/imageUrl, live decisions) — rendered
            // as-is, never joined against this component's own state.
            const rows: AiSortSuggestionRow[] = Array.isArray(body.suggestions) ? body.suggestions : [];
            const responseDecisions: { id: string; name: string }[] = Array.isArray(body.decisions)
                ? body.decisions
                : [];
            const failedCount = Array.isArray(body.failedItemIds) ? body.failedItemIds.length : 0;

            if (rows.length === 0) {
                toast.info("No unsorted items to sort.");
                return;
            }

            setAiSortRows(rows);
            setAiSortDecisions(responseDecisions);
            setAiSortFailedCount(failedCount);
            setAiSortModalOpen(true);
            // The route already persisted every successful suggestion —
            // refresh now so the chips render immediately even if the modal
            // is cancelled.
            refresh();
        } catch (e: any) {
            toast.error(e.message || "Couldn't get AI suggestions.");
        } finally {
            setSorting(false);
        }
    }

    async function handleLinkToSchedule() {
        setLinking(true);
        try {
            const res = await fetch("/api/selections/link-schedule", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ projectId }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(body.error || "Couldn't get schedule-link suggestions.");
            }

            const rows: LinkScheduleSuggestionRow[] = Array.isArray(body.suggestions) ? body.suggestions : [];
            const tasks: { id: string; name: string; startDate: string }[] = Array.isArray(body.tasks) ? body.tasks : [];
            const failedCount = Array.isArray(body.failedDecisionIds) ? body.failedDecisionIds.length : 0;

            if (rows.length === 0) {
                toast.info("No undecided decisions to link.");
                return;
            }

            setLinkScheduleRows(rows);
            setLinkScheduleTasks(tasks);
            setLinkScheduleFailedCount(failedCount);
            setLinkScheduleModalOpen(true);
        } catch (e: any) {
            toast.error(e.message || "Couldn't get schedule-link suggestions.");
        } finally {
            setLinking(false);
        }
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
                    <LinkScheduleReviewModal
                        open={linkScheduleModalOpen}
                        rows={linkScheduleRows}
                        tasks={linkScheduleTasks}
                        failedCount={linkScheduleFailedCount}
                        trigger={
                            <button
                                data-testid="link-to-schedule-button"
                                // Also disabled while the review modal is open —
                                // a second run mid-review would silently replace
                                // the rows being looked at (same reasoning as
                                // Sort with AI's disabled condition).
                                disabled={linking || linkScheduleModalOpen}
                                className="hui-btn hui-btn-accent text-sm flex items-center gap-1.5 disabled:opacity-50"
                            >
                                <Calendar className="w-4 h-4" />
                                {linking ? "Linking…" : "Link to schedule"}
                            </button>
                        }
                        onTriggerClick={handleLinkToSchedule}
                        onClose={() => setLinkScheduleModalOpen(false)}
                        onApplied={refresh}
                    />
                    <ApplyTemplateModal projectId={projectId} onApplied={refresh} />
                    <button onClick={() => setAddDecisionOpen(true)} className="hui-btn hui-btn-green text-sm flex items-center gap-1.5">
                        <Plus className="w-4 h-4" />
                        Add a decision
                    </button>
                </div>
            </div>

            <RiskBanner decisions={decisions} />
            <ApprovedItemsTable decisions={decisions} onChanged={refresh} />

            {/* Anything the client clipped but hasn't filed yet. Sits above the
                decisions because it's the newest input and the only part that
                may need a nudge — every clipper capture lands here first. */}
            {activeUnsorted.length > 0 && (
                <div className="hui-card p-5 mb-5">
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                        <div>
                            <h3 className="text-base font-semibold text-hui-textMain">Unsorted</h3>
                            <p className="text-xs text-hui-textMuted mt-0.5 mb-3">
                                Clipped by the client, not yet in a decision. They sort these themselves — this is just so you can see what&apos;s coming.
                            </p>
                        </div>
                        <AiSortReviewModal
                            open={aiSortModalOpen}
                            projectId={projectId}
                            rows={aiSortRows}
                            decisions={aiSortDecisions}
                            failedCount={aiSortFailedCount}
                            trigger={
                                <button
                                    data-testid="sort-with-ai-button"
                                    // Also disabled while the review modal is
                                    // open — a second run mid-review would
                                    // silently replace the rows the staffer is
                                    // currently looking at.
                                    disabled={sorting || aiSortModalOpen}
                                    // text-sm + py-2 (not the old text-xs/py-1.5)
                                    // to clear the ~36px minimum hit-target height.
                                    className="hui-btn hui-btn-accent text-sm py-2 px-3 flex items-center gap-1.5 disabled:opacity-50"
                                >
                                    <Sparkles className="w-3.5 h-3.5" />
                                    {sorting ? "Sorting…" : "Sort with AI"}
                                </button>
                            }
                            onTriggerClick={handleSortWithAi}
                            onClose={() => setAiSortModalOpen(false)}
                            onApplied={refresh}
                        />
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                        {activeUnsorted.map((item) => (
                            <CandidateCard key={item.id} item={item} isChosen={false} onChanged={refresh} suggestion={resolveSuggestion(item)} />
                        ))}
                    </div>
                </div>
            )}

            {decisions.length === 0 ? (
                activeUnsorted.length === 0 && (
                    <div className="hui-card p-10 text-center">
                        <p className="text-sm text-hui-textMuted">No client decisions yet — they&apos;ll show up here as the client adds items to their playground.</p>
                    </div>
                )
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
                            isAdminOrManager={isAdminOrManager}
                            scheduleTasks={scheduleTasks}
                        />
                    ))}
                </div>
            )}

            <RecentlyDeletedDecisions
                projectId={projectId}
                initialDeleted={initialRecentlyDeleted}
                initialDeletedItems={initialRecentlyDeletedItems}
            />

            <AddDecisionModal projectId={projectId} open={addDecisionOpen} onClose={() => setAddDecisionOpen(false)} onCreated={refresh} />
        </div>
    );
}
