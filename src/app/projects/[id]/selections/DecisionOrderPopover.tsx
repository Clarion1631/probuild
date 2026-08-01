"use client";

// Mark ordered / edit / mark received / clear popover (Phase 4 — Selection
// Order Tracking + Delivery Risk,
// docs/superpowers/plans/2026-07-31-selection-order-tracking.md). Radix
// Dialog, house pattern — mirrors DecisionDueDateEditPopover.tsx.

import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { toast } from "sonner";
import { setDecisionOrderInfo } from "@/lib/actions";
import { toCompanyDayKey } from "@/lib/company-day";
import { Pencil, Package } from "lucide-react";

function toDateInputValue(iso: string | null): string {
    if (!iso) return "";
    return iso.slice(0, 10); // ISO date -> yyyy-mm-dd for <input type="date">
}

// UTC-midnight anchored calendar date — the same convention
// DecisionDueDateEditPopover uses for the manual due-date override, so a
// date-only input round-trips through storage without shifting a day. The
// server re-normalizes to UTC midnight itself too (Codex review round 1,
// issue 7) — this client-side normalization is a courtesy, not the only
// guard.
function dateOnlyToUtcMidnight(value: string): Date {
    return new Date(`${value}T00:00:00.000Z`);
}

type OrderedByValue = "TEAM" | "CLIENT";

function formatOrderHistoryLine(orderedAt: string | null, orderedBy: string | null, expectedArrivalAt: string | null): string {
    // Codex review round 1, issue 4: nullable orderedBy on legacy/edge-case
    // rows must never be invented as "GTR team" — only render a segment when
    // its underlying field is actually present.
    const parts: string[] = ["Ordered"];
    if (orderedAt) {
        const dateLabel = toDateInputValue(orderedAt);
        parts[0] = `Ordered ${dateLabel}`;
    }
    if (orderedBy) {
        const whoLabel = orderedBy === "CLIENT" ? "Client" : "GTR team";
        parts[0] = `${parts[0]} by ${whoLabel}`;
    }
    if (expectedArrivalAt) {
        return `${parts[0]} · arrives ~${toDateInputValue(expectedArrivalAt)}`;
    }
    return parts[0];
}

export default function DecisionOrderPopover({
    decisionId,
    decisionName,
    status,
    orderedAt,
    orderedBy,
    expectedArrivalAt,
    onSaved,
}: {
    decisionId: string;
    decisionName: string;
    status: string;
    orderedAt: string | null;
    orderedBy: string | null;
    expectedArrivalAt: string | null;
    onSaved: () => void;
}) {
    const [open, setOpen] = useState(false);
    // Default the order date to TODAY in company-local time (toCompanyDayKey
    // is browser-safe — no prisma/server-only imports) — a bare
    // `new Date().toISOString()` would show tomorrow's date for most of the
    // Pacific evening.
    const [orderDateDraft, setOrderDateDraft] = useState(toDateInputValue(orderedAt) || toCompanyDayKey(new Date()));
    const [orderedByDraft, setOrderedByDraft] = useState<OrderedByValue>((orderedBy as OrderedByValue) || "TEAM");
    const [etaDraft, setEtaDraft] = useState(toDateInputValue(expectedArrivalAt));
    // Single pending flag (Codex review round 1, issue 3) — Save and
    // Clear/undo must be disabled TOGETHER while either is in flight, so a
    // double-click can't fire a Save racing a Clear against the same row.
    const [pending, setPending] = useState<"save" | "receive" | "clear" | null>(null);

    function handleOpenChange(next: boolean) {
        if (next) {
            // Re-seed from current props each time the popover opens.
            setOrderDateDraft(toDateInputValue(orderedAt) || toCompanyDayKey(new Date()));
            setOrderedByDraft((orderedBy as OrderedByValue) || "TEAM");
            setEtaDraft(toDateInputValue(expectedArrivalAt));
        }
        setOpen(next);
    }

    async function handleSave() {
        if (!orderDateDraft) {
            toast.error("Order date is required.");
            return;
        }
        setPending("save");
        try {
            // Field-level CAS (Codex review round 1, issue 3): send the
            // orderedAt this form was seeded from (null for a fresh
            // Decided -> Ordered transition) so the server can detect a
            // concurrent change to the same row between open and Save.
            const result = await setDecisionOrderInfo(decisionId, {
                kind: "ordered",
                orderedAt: dateOnlyToUtcMidnight(orderDateDraft),
                orderedBy: orderedByDraft,
                expectedArrivalAt: etaDraft ? dateOnlyToUtcMidnight(etaDraft) : null,
                expectedOrderedAt: orderedAt ? dateOnlyToUtcMidnight(toDateInputValue(orderedAt)) : null,
            });
            if (!result.ok) {
                // Typed result (Codex review round 1, issue 1) — production
                // redacts thrown Server Action error messages, so expected
                // validation/CAS failures come back as data instead of a
                // throw, and the real message reaches this toast in prod too.
                toast.error(result.message);
                return;
            }
            toast.success(status === "Decided" ? "Marked ordered." : "Order info updated.");
            setOpen(false);
            onSaved();
        } catch (e: any) {
            toast.error(e?.message || "Couldn't save order info.");
        } finally {
            setPending(null);
        }
    }

    async function handleReceive() {
        setPending("receive");
        try {
            const result = await setDecisionOrderInfo(decisionId, { kind: "received" });
            if (!result.ok) {
                toast.error(result.message);
                return;
            }
            toast.success("Marked received.");
            setOpen(false);
            onSaved();
        } catch (e: any) {
            toast.error(e?.message || "Couldn't mark received.");
        } finally {
            setPending(null);
        }
    }

    async function handleClear() {
        setPending("clear");
        try {
            const result = await setDecisionOrderInfo(decisionId, { kind: "clear" });
            if (!result.ok) {
                toast.error(result.message);
                return;
            }
            toast.success("Order info cleared.");
            setOpen(false);
            onSaved();
        } catch (e: any) {
            toast.error(e?.message || "Couldn't clear order info.");
        } finally {
            setPending(null);
        }
    }

    // Order tracking only makes sense once a decision has been made — Open/
    // Flagged decisions render no affordance here at all.
    if (status !== "Decided" && status !== "Ordered" && status !== "Received") return null;

    const trigger =
        status === "Decided" ? (
            <button
                data-testid={`mark-ordered-trigger-${decisionId}`}
                className="hui-btn hui-btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5"
            >
                <Package className="w-3.5 h-3.5" />
                Mark ordered
            </button>
        ) : (
            <button
                data-testid={`edit-order-trigger-${decisionId}`}
                title="Edit order info"
                aria-label={`Edit order info for ${decisionName}`}
                className="text-slate-400 hover:text-hui-textMain transition"
            >
                <Pencil className="w-3.5 h-3.5" />
            </button>
        );

    // Codex review round 1, issue 2: a Received row showed editable fields
    // + a Save that always sent kind "ordered" (the server rightly rejected
    // it, but the UI dangled a live-looking form that could never succeed).
    // Received is read-only history + ONLY the Clear/undo affordance.
    const isReceived = status === "Received";
    const orderDateInputId = `order-date-input-${decisionId}`;
    const orderEtaInputId = `order-eta-input-${decisionId}`;

    return (
        <Dialog.Root open={open} onOpenChange={handleOpenChange}>
            <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
            <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 bg-black/40 z-50" />
                <Dialog.Content
                    data-testid={`order-popover-${decisionId}`}
                    className="fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 bg-white rounded-xl shadow-2xl max-w-sm w-[calc(100vw-2rem)] focus:outline-none"
                >
                    <div className="px-5 py-4 border-b border-hui-border">
                        <Dialog.Title className="text-sm font-bold text-hui-textMain">Order info — {decisionName}</Dialog.Title>
                    </div>

                    <div className="p-5 space-y-4">
                        {isReceived ? (
                            <p data-testid={`order-history-${decisionId}`} className="text-sm text-hui-textMain">
                                {formatOrderHistoryLine(orderedAt, orderedBy, expectedArrivalAt)} · Received
                            </p>
                        ) : (
                            <>
                                <div>
                                    <label htmlFor={orderDateInputId} className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">
                                        Order date
                                    </label>
                                    <input
                                        type="date"
                                        id={orderDateInputId}
                                        data-testid={orderDateInputId}
                                        className="hui-input text-sm py-1 w-full mt-1"
                                        value={orderDateDraft}
                                        onChange={(e) => setOrderDateDraft(e.target.value)}
                                        disabled={pending !== null}
                                    />
                                </div>
                                <div>
                                    <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Ordered by</label>
                                    <div className="flex items-center gap-4 mt-1">
                                        <label className="flex items-center gap-1.5 text-sm text-hui-textMain">
                                            <input
                                                type="radio"
                                                name={`ordered-by-${decisionId}`}
                                                data-testid={`order-by-team-${decisionId}`}
                                                checked={orderedByDraft === "TEAM"}
                                                onChange={() => setOrderedByDraft("TEAM")}
                                                disabled={pending !== null}
                                            />
                                            GTR team
                                        </label>
                                        <label className="flex items-center gap-1.5 text-sm text-hui-textMain">
                                            <input
                                                type="radio"
                                                name={`ordered-by-${decisionId}`}
                                                data-testid={`order-by-client-${decisionId}`}
                                                checked={orderedByDraft === "CLIENT"}
                                                onChange={() => setOrderedByDraft("CLIENT")}
                                                disabled={pending !== null}
                                            />
                                            Client
                                        </label>
                                    </div>
                                </div>
                                <div>
                                    <label htmlFor={orderEtaInputId} className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">
                                        Expected arrival (optional)
                                    </label>
                                    <input
                                        type="date"
                                        id={orderEtaInputId}
                                        data-testid={orderEtaInputId}
                                        className="hui-input text-sm py-1 w-full mt-1"
                                        value={etaDraft}
                                        onChange={(e) => setEtaDraft(e.target.value)}
                                        disabled={pending !== null}
                                    />
                                </div>
                                <button
                                    data-testid={`order-save-${decisionId}`}
                                    onClick={handleSave}
                                    disabled={pending !== null}
                                    className="hui-btn hui-btn-green text-xs py-1.5 px-3 disabled:opacity-50"
                                >
                                    {pending === "save" ? "Saving…" : "Save"}
                                </button>
                            </>
                        )}

                        {(status === "Ordered" || status === "Received") && (
                            <div className="pt-3 border-t border-hui-border flex items-center gap-2">
                                {status === "Ordered" && (
                                    <button
                                        data-testid={`mark-received-${decisionId}`}
                                        onClick={handleReceive}
                                        disabled={pending !== null}
                                        className="hui-btn hui-btn-secondary text-xs py-1.5 px-3 disabled:opacity-50"
                                    >
                                        {pending === "receive" ? "Saving…" : "Mark received"}
                                    </button>
                                )}
                                <button
                                    data-testid={`order-clear-${decisionId}`}
                                    onClick={handleClear}
                                    disabled={pending !== null}
                                    className="hui-btn hui-btn-secondary text-xs py-1.5 px-3 disabled:opacity-50"
                                >
                                    {pending === "clear" ? "Clearing…" : "Undo / clear"}
                                </button>
                            </div>
                        )}
                    </div>

                    <div className="px-5 py-3 border-t border-hui-border flex justify-end bg-slate-50 rounded-b-xl">
                        <Dialog.Close asChild>
                            <button data-testid={`order-popover-close-${decisionId}`} className="hui-btn hui-btn-secondary text-xs py-1.5 px-3">
                                Close
                            </button>
                        </Dialog.Close>
                    </div>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
