"use client";

import { useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Entry = { id: string; employee: string; project: string; startTime: string; endTime: string | null; paidHours: number | null; updatedAt: string };
export default function VoidTimeEntryButton({ role, entry, timeZone }: { role: string; entry: Entry; timeZone: string }) {
    const router = useRouter();
    const dialog = useRef<HTMLDialogElement>(null);
    const form = useRef<HTMLFormElement>(null);
    const pending = useRef(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [reviewed, setReviewed] = useState(entry);
    const dateFormat = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
    const titleId = useId(); const reasonId = useId();
    if (role !== "ADMIN" && role !== "MANAGER") return null;

    async function submit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (pending.current) return;
        const fields = new FormData(event.currentTarget);
        const reason = String(fields.get("reason") ?? "").trim();
        if (!reason || reason.length > 1000) { setError("Enter a reason of 1–1000 characters."); return; }
        if (fields.get("confirmed") !== "yes") { setError("Confirm that this is the entry you intend to void."); return; }
        pending.current = true; setBusy(true); setError("");
        try {
            const response = await fetch(`/api/time-entries/${encodeURIComponent(reviewed.id)}/void`, {
                method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ reason, expectedUpdatedAt: reviewed.updatedAt }),
            });
            const result = await response.json();
            if (!response.ok) { setError(typeof result.error === "string" ? result.error : "Unable to void this entry. Refresh and review it."); return; }
            if (result.id !== reviewed.id || !result.voidedAt) throw new Error("Unconfirmed response");
            dialog.current?.close(); router.refresh();
        } catch {
            setError("Could not confirm the result. Check Voided history or retry this same entry.");
        } finally { pending.current = false; setBusy(false); }
    }

    return <>
        <button type="button" className="mt-2 text-xs text-red-700 underline" onClick={() => { setReviewed(entry); dialog.current?.showModal(); }}>Void entry</button>
        <dialog ref={dialog} aria-labelledby={titleId} className="m-auto w-[calc(100%-2rem)] max-w-lg rounded-xl border border-hui-border bg-white p-6 shadow-xl backdrop:bg-slate-900/50"
            onCancel={event => { if (pending.current) event.preventDefault(); }} onClose={() => { form.current?.reset(); setError(""); }}>
            <form ref={form} onSubmit={submit} className="space-y-4 text-left text-sm">
                <h2 id={titleId} className="text-lg font-semibold text-hui-textMain">Void this time entry?</h2>
                <div className="rounded-lg bg-slate-50 p-3 text-hui-textMain">
                    <p className="font-semibold">{reviewed.employee} · {reviewed.project}</p>
                    <p>Start: {dateFormat.format(new Date(reviewed.startTime))}</p>
                    <p>End: {reviewed.endTime ? dateFormat.format(new Date(reviewed.endTime)) : "Still open"}</p>
                    <p>Paid hours: {reviewed.paidHours == null ? "Not yet recorded" : reviewed.paidHours.toFixed(2)}</p>
                    <p className="mt-1 break-all text-xs text-hui-textMuted">Entry: {reviewed.id}</p>
                </div>
                <p>This excludes the entry from payroll and operational totals. Original punches and amounts remain in Voided history. This cannot be undone here.</p>
                <div><label htmlFor={reasonId} className="font-medium">Reason</label><textarea id={reasonId} name="reason" required maxLength={1000} rows={3} disabled={busy} className="hui-input mt-1 w-full" /></div>
                <label className="flex items-start gap-2"><input type="checkbox" name="confirmed" value="yes" required disabled={busy} className="mt-1" /><span>I confirm this is the entry I intend to void.</span></label>
                {error && <p role="alert" className="text-red-700">{error}</p>}
                <div className="flex justify-end gap-2"><button type="button" disabled={busy} className="hui-btn" onClick={() => dialog.current?.close()}>Cancel</button><button type="submit" disabled={busy} className="hui-btn bg-red-700 text-white disabled:opacity-50">{busy ? "Voiding…" : "Confirm void"}</button></div>
            </form>
        </dialog>
    </>;
}
