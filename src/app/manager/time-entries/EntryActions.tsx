"use client";

// Per-row admin controls for /manager/time-entries (owner ask 2026-08-31: admins on
// the web must be able to completely edit/delete a time entry; crew self-delete was
// deliberately NOT shipped — PR #436 closed).
//
// Both actions reuse the reviewed API routes rather than new server actions:
//   PATCH  /api/time-entries/[id]  — privileged edit; requires editNotes, recomputes
//          paid hours/costs from the OWNER's rates, stamps editedByManagerId
//          (src/lib/time-entry-edit-audit.ts), and re-settles the day server-side.
//          Closing an OPEN logistics entry requires job notes — the modal shows them
//          PREFILLED with the entry's existing notes so a close never wipes the
//          worker's record (Codex gate, PR #437).
//   DELETE /api/time-entries/[id]  — MANAGER/ADMIN only; deletes and re-settles the
//          day in one transaction (deleteEntryAndSettle).
// The page itself is already MANAGER/ADMIN-gated server-side.
//
// Times are entered in COMPANY time (America/Los_Angeles, labeled Pacific), never the
// browser's zone (src/lib/company-wall-time.ts). DST rules: a nonexistent
// spring-forward time is refused outright; a fall-back time that happens twice makes
// the modal show an explicit first/second choice — payroll never guesses the hour.
// An UNCHANGED field resends the row's original instant verbatim, so the
// minute-granular input cannot round an untouched timestamp's seconds away.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { companyWallToInstants, instantToCompanyWall } from "@/lib/company-wall-time";

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
};

/** "" = unambiguous or not yet needed; "first" | "second" = the user's pick for a fall-back time. */
type DstPick = "" | "first" | "second";

function resolveField(
    wall: string,
    pick: DstPick
): { kind: "ok"; instant: Date } | { kind: "nonexistent" } | { kind: "ambiguous" } {
    const instants = companyWallToInstants(wall);
    if (instants.length === 0) return { kind: "nonexistent" };
    if (instants.length === 1) return { kind: "ok", instant: instants[0] };
    if (pick === "first") return { kind: "ok", instant: instants[0] };
    if (pick === "second") return { kind: "ok", instant: instants[1] };
    return { kind: "ambiguous" };
}

export default function EntryActions({ entryId, userName, startTime, endTime, isLogistics, existingNotes }: Props) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [start, setStart] = useState("");
    const [end, setEnd] = useState("");
    const [startPick, setStartPick] = useState<DstPick>("");
    const [endPick, setEndPick] = useState<DstPick>("");
    const [reason, setReason] = useState("");
    const [jobNotes, setJobNotes] = useState("");
    // The wall-time strings the modal OPENED with — an unchanged field resends the
    // original instant, preserving seconds the minute input cannot represent.
    const initial = useRef({ start: "", end: "" });
    const dialogRef = useRef<HTMLDialogElement>(null);
    const openerRef = useRef<HTMLButtonElement>(null);

    // Every open starts clean from the row's CURRENT values — a canceled draft must
    // never survive into the next edit with a stale reason.
    function openModal() {
        const s = instantToCompanyWall(startTime);
        const e = endTime ? instantToCompanyWall(endTime) : "";
        initial.current = { start: s, end: e };
        setStart(s);
        setEnd(e);
        setStartPick("");
        setEndPick("");
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

    const startAmbiguous = start !== initial.current.start && companyWallToInstants(start).length === 2;
    const endAmbiguous = end !== "" && end !== initial.current.end && companyWallToInstants(end).length === 2;
    const closingOpenEntry = !endTime && end !== "";

    async function saveEdit() {
        if (!reason.trim()) { toast.error("A reason is required for every edit"); return; }
        let startIso: string;
        if (start === initial.current.start) {
            startIso = startTime; // untouched — keep the exact original instant
        } else {
            const r = resolveField(start, startPick);
            if (r.kind === "nonexistent") { toast.error("That start time doesn't exist (clocks spring forward that night)"); return; }
            if (r.kind === "ambiguous") { toast.error("That start time happens twice that night — pick first or second below"); return; }
            startIso = r.instant.toISOString();
        }
        let endIso: string | null = null;
        if (end) {
            if (end === initial.current.end && endTime) {
                endIso = endTime;
            } else {
                const r = resolveField(end, endPick);
                if (r.kind === "nonexistent") { toast.error("That end time doesn't exist (clocks spring forward that night)"); return; }
                if (r.kind === "ambiguous") { toast.error("That end time happens twice that night — pick first or second below"); return; }
                endIso = r.instant.toISOString();
            }
            if (new Date(endIso).getTime() <= new Date(startIso).getTime()) { toast.error("End must be after start"); return; }
        } else if (endTime) {
            // Blank end on a CLOSED entry would silently re-open it — refuse, like mobile does.
            toast.error("This entry is closed — give it an end time");
            return;
        }
        if (closingOpenEntry && isLogistics && !jobNotes.trim()) {
            toast.error("Closing a logistics entry needs job notes — what was the work?");
            return;
        }
        setBusy(true);
        try {
            const res = await fetch(`/api/time-entries/${encodeURIComponent(entryId)}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    startTime: startIso,
                    endTime: endIso,
                    editNotes: reason.trim(),
                    // Only a genuine close-out of a logistics entry sends notes, and they
                    // start from the existing ones — never a silent replacement.
                    ...(closingOpenEntry && isLogistics && jobNotes.trim() ? { notes: jobNotes.trim() } : {}),
                }),
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
                            {userName} — times are Pacific (company time). Paid hours and costs recompute from the worker&apos;s rates; the edit is stamped with your name.
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
