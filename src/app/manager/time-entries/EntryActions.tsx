"use client";

// Per-row admin controls for /manager/time-entries (owner ask 2026-08-31: admins on
// the web must be able to completely edit/delete a time entry; crew self-delete was
// deliberately NOT shipped — PR #436 closed).
//
// Both actions reuse the reviewed API routes rather than new server actions:
//   PATCH  /api/time-entries/[id]  — privileged edit; requires editNotes, recomputes
//          paid hours/costs from the OWNER's rates, stamps editedByManagerId, and
//          re-settles the day (WA meal rules) server-side.
//   DELETE /api/time-entries/[id]  — MANAGER/ADMIN only; deletes and re-settles the
//          day in one transaction (deleteEntryAndSettle).
// The page itself is already MANAGER/ADMIN-gated server-side.
//
// Times are entered and displayed in COMPANY time (America/Los_Angeles), never the
// browser's zone — payroll settles on the company day, and a traveling manager's
// device zone must not shift a punch by hours (Codex gate, PR #437). The wall-time ↔
// instant conversion below is the same fixed-point trick company-day.ts uses.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { COMPANY_TIME_ZONE } from "@/lib/company-day";

type Props = {
    entryId: string;
    userName: string;
    /** ISO strings (serialized by the server component). endTime null = still clocked in. */
    startTime: string;
    endTime: string | null;
};

const WALL_PARTS = new Intl.DateTimeFormat("en-CA", {
    timeZone: COMPANY_TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23",
});

function wallPartsOf(instant: Date): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
    const parts = WALL_PARTS.formatToParts(instant);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
    return { y: get("year"), mo: get("month"), d: get("day"), h: get("hour"), mi: get("minute"), s: get("second") };
}

/** Instant -> value for <input type="datetime-local">, as COMPANY-local wall time. */
function toCompanyInputValue(iso: string): string {
    const w = wallPartsOf(new Date(iso));
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${w.y}-${pad(w.mo)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}`;
}

/** "YYYY-MM-DDTHH:MM" read as COMPANY-local wall time -> UTC instant (null if unparseable). */
function fromCompanyInputValue(value: string): Date | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
    if (!m) return null;
    const [y, mo, d, h, mi] = m.slice(1).map(Number);
    const wanted = Date.UTC(y, mo - 1, d, h, mi, 0);
    // Fixed-point correction: read the guess back as company wall time and subtract the
    // error. Converges in one pass except across a DST switch, where a second lands it.
    let guess = wanted + 8 * 3_600_000; // Pacific is UTC-7/-8; start near the answer
    for (let i = 0; i < 3; i++) {
        const w = wallPartsOf(new Date(guess));
        const asUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
        const diff = asUtc - wanted;
        if (diff === 0) break;
        guess -= diff;
    }
    return new Date(guess);
}

export default function EntryActions({ entryId, userName, startTime, endTime }: Props) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [start, setStart] = useState("");
    const [end, setEnd] = useState("");
    const [reason, setReason] = useState("");
    const openerRef = useRef<HTMLButtonElement>(null);
    const dialogRef = useRef<HTMLDivElement>(null);
    const firstFieldRef = useRef<HTMLInputElement>(null);

    // Every open starts clean from the row's CURRENT values — a canceled draft must
    // never survive into the next edit with a stale reason (Codex gate, PR #437).
    function openModal() {
        setStart(toCompanyInputValue(startTime));
        setEnd(endTime ? toCompanyInputValue(endTime) : "");
        setReason("");
        setOpen(true);
    }
    function closeModal() {
        if (busy) return;
        setOpen(false);
        openerRef.current?.focus();
    }

    // Dialog semantics: initial focus into the form, Escape closes, Tab stays inside.
    useEffect(() => {
        if (!open) return;
        firstFieldRef.current?.focus();
        function onKeyDown(e: KeyboardEvent) {
            if (e.key === "Escape") { e.stopPropagation(); closeModal(); return; }
            if (e.key !== "Tab") return;
            const root = dialogRef.current;
            if (!root) return;
            const focusables = Array.from(
                root.querySelectorAll<HTMLElement>("input, button, [tabindex]:not([tabindex='-1'])")
            ).filter((el) => !el.hasAttribute("disabled"));
            if (focusables.length === 0) return;
            const first = focusables[0];
            const last = focusables[focusables.length - 1];
            const active = document.activeElement as HTMLElement | null;
            if (e.shiftKey && (active === first || !root.contains(active))) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && (active === last || !root.contains(active))) { e.preventDefault(); first.focus(); }
        }
        document.addEventListener("keydown", onKeyDown, true);
        return () => document.removeEventListener("keydown", onKeyDown, true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, busy]);

    async function saveEdit() {
        if (!reason.trim()) { toast.error("A reason is required for every edit"); return; }
        const startDate = fromCompanyInputValue(start);
        if (!startDate) { toast.error("Enter a valid start time"); return; }
        let endIso: string | null = null;
        if (end) {
            const endDate = fromCompanyInputValue(end);
            if (!endDate) { toast.error("Enter a valid end time"); return; }
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
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={closeModal}>
                    <div
                        ref={dialogRef}
                        role="dialog"
                        aria-modal="true"
                        aria-label={`Edit time entry for ${userName}`}
                        className="hui-card w-full max-w-md p-6 text-left space-y-4"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div>
                            <h3 className="font-semibold text-hui-textMain">Edit time entry</h3>
                            <p className="text-xs text-hui-textMuted">
                                {userName} — times are Pacific (company time). Paid hours and costs recompute from the worker&apos;s rates; the edit is stamped with your name.
                            </p>
                        </div>
                        <label className="block text-sm">
                            <span className="text-xs font-medium text-hui-textMuted">Start (Pacific)</span>
                            <input ref={firstFieldRef} type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} className="hui-input mt-1 w-full text-sm" />
                        </label>
                        <label className="block text-sm">
                            <span className="text-xs font-medium text-hui-textMuted">End (Pacific){endTime ? "" : " — blank = still clocked in"}</span>
                            <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} className="hui-input mt-1 w-full text-sm" />
                        </label>
                        <label className="block text-sm">
                            <span className="text-xs font-medium text-hui-textMuted">Reason (required)</span>
                            <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Forgot to clock out" className="hui-input mt-1 w-full text-sm" />
                        </label>
                        <div className="flex justify-end gap-2 pt-2">
                            <button type="button" onClick={closeModal} disabled={busy} className="hui-btn hui-btn-secondary text-sm">Cancel</button>
                            <button type="button" onClick={saveEdit} disabled={busy} className="hui-btn hui-btn-primary text-sm disabled:opacity-40">{busy ? "Saving…" : "Save"}</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
