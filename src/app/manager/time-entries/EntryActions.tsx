"use client";

// Per-row admin controls for /manager/time-entries (owner ask 2026-08-31: admins on
// the web must be able to completely edit/delete a time entry; crew self-delete was
// deliberately NOT shipped — PR #436 closed).
//
// Both actions reuse the reviewed API routes rather than new server actions:
//   PATCH  /api/time-entries/[id]  — privileged edit; requires editNotes, recomputes
//          paid hours/costs from the OWNER's rates, stamps editedByManagerId
//          (src/lib/time-entry-edit-audit.ts), and re-settles the day server-side.
//   DELETE /api/time-entries/[id]  — MANAGER/ADMIN only; deletes and re-settles the
//          day in one transaction (deleteEntryAndSettle).
// The page itself is already MANAGER/ADMIN-gated server-side.
//
// Invoiced entries are billing source data — the row shows "Invoiced" instead of
// actions, and the server refuses edits/deletes of them anyway (Codex gate, PR #437).
//
// Stale-props hygiene (the page can sit open while workers punch): the save sends ONLY
// what the manager actually changed — an untouched start/end is omitted entirely, and
// a blank end is never sent as an explicit null, so a clock-out that landed meanwhile
// cannot be silently undone (the server additionally refuses re-opening).
//
// Times are entered in COMPANY time (America/Los_Angeles, labeled Pacific), never the
// browser's zone (src/lib/company-wall-time.ts). DST rules: a nonexistent
// spring-forward time is refused; a fall-back time that happens twice shows an
// explicit first/second choice — seeded from the STORED occurrence, so a punch saved
// in the wrong occurrence can be corrected without changing the wall-time string.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
    companyWallToInstants,
    instantToCompanyWall,
    occurrenceOf,
    pickInstant,
    type DstPick,
} from "@/lib/company-wall-time";

type Props = {
    entryId: string;
    userName: string;
    /** ISO strings (serialized by the server component). endTime null = still clocked in. */
    startTime: string;
    endTime: string | null;
    /** Logistics project: closing an open entry requires job notes (server-enforced). */
    isLogistics: boolean;
    /** The entry's current job notes — prefill so a logistics close preserves them. */
    existingNotes: string;
    /** On an invoice: no actions here (server refuses too). */
    invoiced: boolean;
};

export default function EntryActions({ entryId, userName, startTime, endTime, isLogistics, existingNotes, invoiced }: Props) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [start, setStart] = useState("");
    const [end, setEnd] = useState("");
    const [startPick, setStartPick] = useState<DstPick>("");
    const [endPick, setEndPick] = useState<DstPick>("");
    const [reason, setReason] = useState("");
    const [jobNotes, setJobNotes] = useState("");
    // What the modal OPENED with — a field (wall string AND occurrence pick) that
    // matches its initial value is treated as untouched and OMITTED from the PATCH.
    const initial = useRef({ start: "", end: "", startPick: "" as DstPick, endPick: "" as DstPick });
    const dialogRef = useRef<HTMLDialogElement>(null);
    const openerRef = useRef<HTMLButtonElement>(null);

    // Every open starts clean from the row's CURRENT values — a canceled draft must
    // never survive into the next edit with a stale reason.
    function openModal() {
        const s = instantToCompanyWall(startTime);
        const e = endTime ? instantToCompanyWall(endTime) : "";
        // Seed the DST picks from the STORED instants, so an ambiguous punch shows
        // which occurrence it currently is — and flipping the radio alone is an edit.
        const sPick = occurrenceOf(s, new Date(startTime));
        const ePick = endTime ? occurrenceOf(e, new Date(endTime)) : "";
        initial.current = { start: s, end: e, startPick: sPick, endPick: ePick };
        setStart(s);
        setEnd(e);
        setStartPick(sPick);
        setEndPick(ePick);
        setReason("");
        setJobNotes(existingNotes);
        setOpen(true);
    }
    function closeModal() {
        if (busy) return;
        setOpen(false);
        openerRef.current?.focus();
    }

    // Native <dialog>.showModal(): true modality — inert background for keyboard AND
    // assistive tech, Escape via the cancel event, focus handled by the platform.
    useEffect(() => {
        const dialog = dialogRef.current;
        if (open && dialog && !dialog.open) dialog.showModal();
        if (!open && dialog?.open) dialog.close();
    }, [open]);

    const startAmbiguous = companyWallToInstants(start).length === 2;
    const endAmbiguous = end !== "" && companyWallToInstants(end).length === 2;
    const startTouched = start !== initial.current.start || startPick !== initial.current.startPick;
    const endTouched = end !== initial.current.end || endPick !== initial.current.endPick;
    const closingOpenEntry = !endTime && end !== "";

    async function saveEdit() {
        if (!reason.trim()) { toast.error("A reason is required for every edit"); return; }
        // Only what changed is sent — untouched fields are omitted so a concurrent
        // change (a worker's clock-out, newer notes) is never overwritten by stale props.
        const patch: Record<string, unknown> = { editNotes: reason.trim() };
        let startMs = new Date(startTime).getTime();
        if (startTouched) {
            const parsed = pickInstant(start, startPick);
            if (!parsed) {
                toast.error(startAmbiguous ? "That start time happens twice that night — pick first or second" : "That start time doesn't exist (clocks spring forward that night)");
                return;
            }
            patch.startTime = parsed.toISOString();
            startMs = parsed.getTime();
        }
        if (end === "") {
            if (endTime) {
                // Blank end on a CLOSED entry would re-open it — refuse, like mobile does
                // (the server refuses this too).
                toast.error("This entry is closed — give it an end time");
                return;
            }
            // Open entry, left open: send nothing about the end at all.
        } else if (endTouched) {
            const parsed = pickInstant(end, endPick);
            if (!parsed) {
                toast.error(endAmbiguous ? "That end time happens twice that night — pick first or second" : "That end time doesn't exist (clocks spring forward that night)");
                return;
            }
            if (parsed.getTime() <= startMs) { toast.error("End must be after start"); return; }
            patch.endTime = parsed.toISOString();
        }
        if (closingOpenEntry && isLogistics) {
            if (!jobNotes.trim()) { toast.error("Closing a logistics entry needs job notes — what was the work?"); return; }
            patch.notes = jobNotes.trim();
        }
        if (Object.keys(patch).length === 1) { toast.error("Nothing changed — adjust a time first"); return; }
        setBusy(true);
        try {
            const res = await fetch(`/api/time-entries/${encodeURIComponent(entryId)}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(patch),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(body?.error || `Edit failed (${res.status})`);
            toast.success("Entry updated");
            setOpen(false);
            openerRef.current?.focus();
            router.refresh();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : "Edit failed");
        } finally {
            setBusy(false);
        }
    }

    async function handleDelete() {
        if (!confirm(`Permanently delete this time entry for ${userName}? The day's hours re-settle automatically.`)) return;
        setBusy(true);
        try {
            const res = await fetch(`/api/time-entries/${encodeURIComponent(entryId)}`, { method: "DELETE" });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(body?.error || `Delete failed (${res.status})`);
            toast.success("Entry deleted");
            router.refresh();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : "Delete failed");
        } finally {
            setBusy(false);
        }
    }

    if (invoiced) {
        return (
            <span className="text-xs text-hui-textMuted" title="On an invoice — remove it from the invoice before editing or deleting">
                Invoiced
            </span>
        );
    }

    function dstPicker(value: DstPick, onChange: (v: DstPick) => void, label: string) {
        return (
            <div className="mt-1 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2 space-y-1">
                <div>{label} happens twice that night (clocks fall back) — which one?</div>
                <label className="flex items-center gap-1.5">
                    <input type="radio" checked={value === "first"} onChange={() => onChange("first")} />
                    First time it shows on the clock (before the fall-back)
                </label>
                <label className="flex items-center gap-1.5">
                    <input type="radio" checked={value === "second"} onChange={() => onChange("second")} />
                    Second time (after the fall-back)
                </label>
            </div>
        );
    }

    return (
        <div className="flex items-center justify-center gap-2">
            <button
                type="button"
                ref={openerRef}
                onClick={openModal}
                disabled={busy}
                className="text-hui-textMuted hover:text-hui-textMain underline disabled:opacity-40"
            >
                Edit
            </button>
            <button
                type="button"
                onClick={handleDelete}
                disabled={busy}
                className="text-hui-textMuted hover:text-red-600 underline disabled:opacity-40"
            >
                Delete
            </button>

            {open && (
                <dialog
                    ref={dialogRef}
                    aria-label={`Edit time entry for ${userName}`}
                    onCancel={(e) => { e.preventDefault(); closeModal(); }}
                    onClick={(e) => { if (e.target === dialogRef.current) closeModal(); }}
                    className="hui-card w-full max-w-md p-6 text-left backdrop:bg-black/40 open:flex open:flex-col gap-4"
                >
                    <div>
                        <h3 className="font-semibold text-hui-textMain">Edit time entry</h3>
                        <p className="text-xs text-hui-textMuted">
                            {userName} — times are Pacific (company time). Only the fields you change are saved. Paid hours and costs recompute from the worker&apos;s rates; the edit is stamped with your name.
                        </p>
                    </div>
                    <label className="block text-sm">
                        <span className="text-xs font-medium text-hui-textMuted">Start (Pacific)</span>
                        <input type="datetime-local" autoFocus value={start} onChange={(e) => { setStart(e.target.value); setStartPick(""); }} className="hui-input mt-1 w-full text-sm" />
                    </label>
                    {startAmbiguous && dstPicker(startPick, setStartPick, "The start time")}
                    <label className="block text-sm">
                        <span className="text-xs font-medium text-hui-textMuted">End (Pacific){endTime ? "" : " — blank = still clocked in"}</span>
                        <input type="datetime-local" value={end} onChange={(e) => { setEnd(e.target.value); setEndPick(""); }} className="hui-input mt-1 w-full text-sm" />
                    </label>
                    {endAmbiguous && dstPicker(endPick, setEndPick, "The end time")}
                    {closingOpenEntry && isLogistics && (
                        <label className="block text-sm">
                            <span className="text-xs font-medium text-hui-textMuted">Job notes (required to close a logistics entry{existingNotes ? " — prefilled from the entry" : ""})</span>
                            <input type="text" value={jobNotes} onChange={(e) => setJobNotes(e.target.value)} placeholder="What was the work?" className="hui-input mt-1 w-full text-sm" />
                        </label>
                    )}
                    <label className="block text-sm">
                        <span className="text-xs font-medium text-hui-textMuted">Reason (required)</span>
                        <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Forgot to clock out" className="hui-input mt-1 w-full text-sm" />
                    </label>
                    <div className="flex justify-end gap-2 pt-2">
                        <button type="button" onClick={closeModal} disabled={busy} className="hui-btn hui-btn-secondary text-sm">Cancel</button>
                        <button type="button" onClick={saveEdit} disabled={busy} className="hui-btn hui-btn-primary text-sm disabled:opacity-40">{busy ? "Saving…" : "Save"}</button>
                    </div>
                </dialog>
            )}
        </div>
    );
}
