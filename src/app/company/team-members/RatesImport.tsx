"use client";

// Gusto rate import (Phase 5 spec G1). Two explicit steps, never one:
// PREVIEW computes the diff and writes nothing; SAVE applies only the rows the
// human ticked. Both call the same pure matcher (src/lib/rate-import.ts) via
// the server actions, so what is shown is what is written.
//
// hourlyRate only — burdenRate is not in Gusto's export and stays on the
// team-member editor (spec section 7 risk 4).

import { useRef, useState } from "react";
import { toast } from "sonner";
import { applyGustoRateImport, previewGustoRateImport } from "@/lib/actions";
import type { RateDiffRow } from "@/lib/rate-import";

export default function RatesImport({ onImported }: { onImported: () => void }) {
    const [open, setOpen] = useState(false);
    const [csvText, setCsvText] = useState("");
    // Each row carries its own fingerprint (see rowFingerprint) so a human can
    // tick a SUBSET without the save being rejected wholesale.
    const [rows, setRows] = useState<RateDiffRow[] | null>(null);
    const [errors, setErrors] = useState<string[]>([]);
    const [selected, setSelected] = useState<Record<string, boolean>>({});
    const [busy, setBusy] = useState(false);
    const fileRef = useRef<HTMLInputElement>(null);

    const reset = () => {
        setCsvText("");
        setRows(null);
        setErrors([]);
        setSelected({});
    };

    const close = () => {
        setOpen(false);
        reset();
    };

    async function handleFile(file: File | undefined) {
        if (!file) return;
        const text = await file.text();
        setCsvText(text);
        setRows(null);
    }

    async function handlePreview() {
        setBusy(true);
        try {
            const result = await previewGustoRateImport(csvText);
            if (!result.success) {
                toast.error(result.error);
                return;
            }
            setRows(result.rows);
            setErrors(result.errors);
            // Pre-tick exactly the rows that would actually change something.
            // Pre-tick only EMAIL-matched changes. A name-only match is exactly
            // the row a human should have to look at before it writes a pay
            // rate, so it starts unticked.
            const next: Record<string, boolean> = {};
            for (const row of result.rows) {
                if (row.userId && row.changed && row.matchedBy === "email") next[row.userId] = true;
            }
            setSelected(next);
            if (result.rows.length === 0) toast.warning("No rows found in that file.");
        } catch (error: any) {
            toast.error(error?.message || "Could not read that CSV");
        } finally {
            setBusy(false);
        }
    }

    async function handleSave() {
        const payload = (rows ?? [])
            .filter((row) => row.userId && selected[row.userId])
            .map((row) => ({
                userId: row.userId as string,
                newHourly: row.newHourly,
                payType: row.payType,
                rowHash: row.rowHash as string,
            }));
        if (payload.length === 0) {
            toast.error("Tick at least one rate to save.");
            return;
        }
        setBusy(true);
        try {
            // The raw file goes with it so the server can re-parse and refuse:
            // the browser's "no errors" is not evidence.
            const result = await applyGustoRateImport(payload, csvText);
            if (!result.success) {
                toast.error(result.error);
                return;
            }
            toast.success(`Updated ${result.updated} pay rate${result.updated === 1 ? "" : "s"}.`);
            close();
            onImported();
        } catch (error: any) {
            toast.error(error?.message || "Could not save those rates");
        } finally {
            setBusy(false);
        }
    }

    const changedCount = (rows ?? []).filter((row) => row.userId && row.changed).length;
    const unmatchedCount = (rows ?? []).filter((row) => !row.userId).length;

    return (
        <>
            <button type="button" onClick={() => setOpen(true)} className="hui-btn hui-btn-secondary text-sm">
                Import CSV
            </button>

            {open && (
                <div className="fixed inset-0 bg-slate-900/50 flex flex-col items-center justify-center z-50 p-4">
                    <div className="bg-white rounded-xl shadow-xl max-w-3xl w-full max-h-[85vh] overflow-hidden border border-hui-border flex flex-col">
                        <div className="px-6 py-4 border-b border-hui-border flex justify-between items-center">
                            <h2 className="text-lg font-bold text-hui-textMain">Import pay rates from Gusto</h2>
                            <button onClick={close} className="text-hui-textMuted hover:text-hui-textMain transition" aria-label="Close">
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                            </button>
                        </div>

                        <div className="p-6 space-y-4 text-sm overflow-y-auto">
                            <p className="text-hui-textMuted leading-relaxed">
                                Export employees from Gusto, then drop the file here or paste it below. Rows are matched on
                                email first, then on an exact full name. Hourly rates only — burden rate stays on each team
                                member&apos;s own page.
                            </p>

                            <div className="flex items-center gap-3">
                                <input
                                    ref={fileRef}
                                    type="file"
                                    accept=".csv,text/csv"
                                    onChange={(e) => handleFile(e.target.files?.[0])}
                                    className="text-sm"
                                />
                            </div>

                            <textarea
                                value={csvText}
                                onChange={(e) => { setCsvText(e.target.value); setRows(null); }}
                                rows={6}
                                placeholder="First name,Last name,Work email,Compensation rate&#10;Tim,Brennan,tim@example.com,$28.00"
                                className="hui-input w-full font-mono text-xs"
                            />

                            {errors.length > 0 && (
                                <ul className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-3 space-y-1">
                                    {errors.map((error) => <li key={error}>{error}</li>)}
                                </ul>
                            )}

                            {rows && (
                                <div className="border border-hui-border rounded overflow-hidden">
                                    <div className="px-4 py-2 bg-slate-50 border-b border-hui-border text-xs text-hui-textMuted">
                                        {changedCount} rate{changedCount === 1 ? "" : "s"} would change
                                        {unmatchedCount > 0 && ` · ${unmatchedCount} row${unmatchedCount === 1 ? "" : "s"} matched nobody`}
                                    </div>
                                    <table className="w-full text-left text-xs">
                                        <thead className="text-hui-textMuted border-b border-hui-border">
                                            <tr>
                                                <th className="px-3 py-2 font-normal w-8"></th>
                                                <th className="px-3 py-2 font-normal">Team member</th>
                                                <th className="px-3 py-2 font-normal text-right">Current</th>
                                                <th className="px-3 py-2 font-normal text-right">From CSV</th>
                                                <th className="px-3 py-2 font-normal">Note</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-hui-border">
                                            {rows.map((row, index) => (
                                                <tr key={row.userId ?? `unmatched-${index}`} className={row.userId ? "" : "bg-amber-50/40"}>
                                                    <td className="px-3 py-2">
                                                        <input
                                                            type="checkbox"
                                                            disabled={!row.userId}
                                                            checked={!!(row.userId && selected[row.userId])}
                                                            onChange={(e) =>
                                                                row.userId && setSelected({ ...selected, [row.userId]: e.target.checked })
                                                            }
                                                        />
                                                    </td>
                                                    <td className="px-3 py-2">
                                                        <div className="font-medium text-hui-textMain">
                                                            {row.name || "—"}
                                                            {row.matchedBy === "name" && (
                                                                <span
                                                                    className="ml-2 text-[10px] uppercase tracking-wide text-amber-800 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5"
                                                                    title="Matched on name alone — no email in the file matched a team member. Check this is the right person before saving."
                                                                >
                                                                    name match
                                                                </span>
                                                            )}
                                                        </div>
                                                        <div className="text-hui-textMuted">{row.email || ""}</div>
                                                    </td>
                                                    <td className="px-3 py-2 text-right tabular-nums text-hui-textMuted">
                                                        {row.oldHourly == null ? "—" : `$${row.oldHourly}/h`}
                                                    </td>
                                                    <td className={`px-3 py-2 text-right tabular-nums font-medium ${row.changed ? "text-hui-textMain" : "text-hui-textMuted"}`}>
                                                        {/* Rendered from the exact decimal TEXT that will be written —
                                                            not re-parsed through a float on the way to the screen. */}
                                                        ${row.newHourly}/h
                                                        {row.payType && (
                                                            <div className="text-[10px] font-normal text-hui-textMuted uppercase tracking-wide">
                                                                {row.payType === "SALARY" ? "salary" : "hourly"}
                                                            </div>
                                                        )}
                                                    </td>
                                                    <td className="px-3 py-2 text-hui-textMuted">
                                                        {row.note ?? (row.changed ? "" : "No change")}
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </div>

                        <div className="px-6 py-4 flex justify-end gap-3 border-t border-hui-border">
                            <button type="button" onClick={close} className="hui-btn hui-btn-secondary">Cancel</button>
                            {rows ? (
                                <button
                                    type="button"
                                    onClick={handleSave}
                                    disabled={busy || errors.length > 0}
                                    title={
                                        errors.length > 0
                                            ? "Fix the unreadable rows first — a half-imported file is worse than none"
                                            : undefined
                                    }
                                    className="hui-btn hui-btn-primary disabled:opacity-50"
                                >
                                    {busy ? "Saving..." : "Save rates"}
                                </button>
                            ) : (
                                <button type="button" onClick={handlePreview} disabled={busy || !csvText.trim()} className="hui-btn hui-btn-primary disabled:opacity-50">
                                    {busy ? "Reading..." : "Preview changes"}
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
