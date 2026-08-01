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
// date-only input round-trips through storage without shifting a day.
function dateOnlyToUtcMidnight(value: string): Date {
    return new Date(`${value}T00:00:00.000Z`);
}

type OrderedByValue = "TEAM" | "CLIENT";

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
    const [saving, setSaving] = useState(false);
    const [busyAction, setBusyAction] = useState<"receive" | "clear" | null>(null);

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
        setSaving(true);
        try {
            await setDecisionOrderInfo(decisionId, {
                kind: "ordered",
                orderedAt: dateOnlyToUtcMidnight(orderDateDraft),
                orderedBy: orderedByDraft,
                expectedArrivalAt: etaDraft ? dateOnlyToUtcMidnight(etaDraft) : null,
            });
            toast.success(status === "Decided" ? "Marked ordered." : "Order info updated.");
            setOpen(false);
            onSaved();
        } catch (e: any) {
            toast.error(e?.message || "Couldn't save order info.");
        } finally {
            setSaving(false);
        }
    }

    async function handleReceive() {
        setBusyAction("receive");
        try {
            await setDecisionOrderInfo(decisionId, { kind: "received" });
            toast.success("Marked received.");
            setOpen(false);
            onSaved();
        } catch (e: any) {
            toast.error(e?.message || "Couldn't mark received.");
        } finally {
            setBusyAction(null);
        }
    }

    async function handleClear() {
        setBusyAction("clear");
        try {
            await setDecisionOrderInfo(decisionId, { kind: "clear" });
            toast.success("Order info cleared.");
            setOpen(false);
            onSaved();
        } catch (e: any) {
            toast.error(e?.message || "Couldn't clear order info.");
        } finally {
            setBusyAction(null);
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
                        <div>
                            <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Order date</label>
                            <input
                                type="date"
                                data-testid={`order-date-input-${decisionId}`}
                                className="hui-input text-sm py-1 w-full mt-1"
                                value={orderDateDraft}
                                onChange={(e) => setOrderDateDraft(e.target.value)}
                                disabled={saving}
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
                                        disabled={saving}
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
                                        disabled={saving}
                                    />
                                    Client
                                </label>
                            </div>
                        </div>
                        <div>
                            <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Expected arrival (optional)</label>
                            <input
                                type="date"
                                data-testid={`order-eta-input-${decisionId}`}
                                className="hui-input text-sm py-1 w-full mt-1"
                                value={etaDraft}
                                onChange={(e) => setEtaDraft(e.target.value)}
                                disabled={saving}
                            />
                        </div>
                        <button
                            data-testid={`order-save-${decisionId}`}
                            onClick={handleSave}
                            disabled={saving}
                            className="hui-btn hui-btn-green text-xs py-1.5 px-3 disabled:opacity-50"
                        >
                            {saving ? "Saving…" : "Save"}
                        </button>

                        {(status === "Ordered" || status === "Received") && (
                            <div className="pt-3 border-t border-hui-border flex items-center gap-2">
                                {status === "Ordered" && (
                                    <button
                                        data-testid={`mark-received-${decisionId}`}
                                        onClick={handleReceive}
                                        disabled={busyAction !== null}
                                        className="hui-btn hui-btn-secondary text-xs py-1.5 px-3 disabled:opacity-50"
                                    >
                                        {busyAction === "receive" ? "Saving…" : "Mark received"}
                                    </button>
                                )}
                                <button
                                    data-testid={`order-clear-${decisionId}`}
                                    onClick={handleClear}
                                    disabled={busyAction !== null}
                                    className="hui-btn hui-btn-secondary text-xs py-1.5 px-3 disabled:opacity-50"
                                >
                                    {busyAction === "clear" ? "Clearing…" : "Undo / clear"}
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
