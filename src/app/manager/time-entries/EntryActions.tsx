"use client";

// Per-row admin controls for /manager/time-entries (owner ask 2026-08-31: admins on
// the web must be able to completely edit/delete a time entry; crew self-delete was
// deliberately NOT shipped — PR #436 closed).
//
// Both actions reuse the reviewed API routes rather than new server actions:
//   PATCH  /api/time-entries/[id]  — manager edit of anyone's times; requires editNotes,
//          recomputes paid hours/costs from the OWNER's rates, stamps editedByManagerId,
//          and re-settles the day (WA meal rules) server-side.
//   DELETE /api/time-entries/[id]  — MANAGER/ADMIN only; deletes and re-settles the
//          day in one transaction (deleteEntryAndSettle).
// The page itself is already MANAGER/ADMIN-gated server-side.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

type Props = {
    entryId: string;
    userName: string;
    /** ISO strings (serialized by the server component). endTime null = still clocked in. */
    startTime: string;
    endTime: string | null;
};

/** Date -> value for <input type="datetime-local"> in the BROWSER's local time. */
function toLocalInputValue(iso: string): string {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function EntryActions({ entryId, userName, startTime, endTime }: Props) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [start, setStart] = useState(() => toLocalInputValue(startTime));
    const [end, setEnd] = useState(() => (endTime ? toLocalInputValue(endTime) : ""));
    const [reason, setReason] = useState("");

    async function saveEdit() {
        if (!reason.trim()) { toast.error("A reason is required for every edit"); return; }
        const startDate = new Date(start);
        if (!start || Number.isNaN(startDate.getTime())) { toast.error("Enter a valid start time"); return; }
        let endIso: string | null = null;
        if (end) {
            const endDate = new Date(end);
            if (Number.isNaN(endDate.getTime())) { toast.error("Enter a valid end time"); return; }
            if (endDate.getTime() <= startDate.getTime()) { toast.error("End must be after start"); return; }
            endIso = endDate.toISOString();
        } else if (endTime) {
            // Blank end on a CLOSED entry would silently re-open it — refuse, like mobile does.
            toast.error("This entry is closed — give it an end time");
            return;
        }
        setBusy(true);
        try {
            const res = await fetch(`/api/time-entries/${encodeURIComponent(entryId)}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ startTime: startDate.toISOString(), endTime: endIso, editNotes: reason.trim() }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(body?.error || `Edit failed (${res.status})`);
            toast.success("Entry updated");
            setOpen(false);
            setReason("");
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

    return (
        <div className="flex items-center justify-center gap-2">
            <button
                type="button"
                onClick={() => setOpen(true)}
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
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => !busy && setOpen(false)}>
                    <div className="hui-card w-full max-w-md p-6 text-left space-y-4" onClick={(e) => e.stopPropagation()}>
                        <div>
                            <h3 className="font-semibold text-hui-textMain">Edit time entry</h3>
                            <p className="text-xs text-hui-textMuted">{userName} — paid hours and costs recompute from the worker&apos;s rates; the edit is stamped with your name.</p>
                        </div>
                        <label className="block text-sm">
                            <span className="text-xs font-medium text-hui-textMuted">Start</span>
                            <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} className="hui-input mt-1 w-full text-sm" />
                        </label>
                        <label className="block text-sm">
                            <span className="text-xs font-medium text-hui-textMuted">End {endTime ? "" : "(blank = still clocked in)"}</span>
                            <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} className="hui-input mt-1 w-full text-sm" />
                        </label>
                        <label className="block text-sm">
                            <span className="text-xs font-medium text-hui-textMuted">Reason (required)</span>
                            <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Forgot to clock out" className="hui-input mt-1 w-full text-sm" />
                        </label>
                        <div className="flex justify-end gap-2 pt-2">
                            <button type="button" onClick={() => setOpen(false)} disabled={busy} className="hui-btn hui-btn-secondary text-sm">Cancel</button>
                            <button type="button" onClick={saveEdit} disabled={busy} className="hui-btn hui-btn-primary text-sm disabled:opacity-40">{busy ? "Saving…" : "Save"}</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
