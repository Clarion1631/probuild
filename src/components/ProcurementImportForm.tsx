"use client";

import { useRef, useState } from "react";

type ReviewRow = {
  rowNumber: number;
  description: string;
  sourceProjectRef: string | null;
  validationState: "READY" | "DATA_GAP" | "PROJECT_CONFLICT";
};

type StageResult = {
  importRun: { id: string; status: string; rowCount: number; dataGapCount: number; conflictCount: number };
  reviewRows?: ReviewRow[];
};

export function ProcurementImportForm({ projectId, projectName }: { projectId: string; projectName: string }) {
  const requestId = useRef<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<StageResult | null>(null);

  async function stage() {
    if (!file) return;
    setBusy(true);
    setError(null);
    if (!requestId.current) requestId.current = crypto.randomUUID();
    const form = new FormData();
    form.set("projectId", projectId);
    form.set("requestId", requestId.current);
    form.set("file", file);
    try {
      const response = await fetch("/api/procurement/imports", { method: "POST", body: form });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not stage this file");
      setResult(body as StageResult);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not stage this file");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">Step 1 — choose the job</p>
      <h1 className="mt-1 text-2xl font-semibold text-stone-900">Import materials for {projectName}</h1>
      <p className="mt-2 max-w-2xl text-sm text-stone-600">
        This screen stages a spreadsheet only. It does not create a PO, change QuickBooks, or mark anything received.
      </p>

      <label className="mt-5 block rounded-lg border-2 border-dashed border-stone-300 p-4 text-sm text-stone-700">
        <span className="font-medium">XLSX file</span>
        <input
          className="mt-2 block w-full text-sm"
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(event) => {
            requestId.current = null;
            setResult(null);
            setError(null);
            setFile(event.target.files?.[0] ?? null);
          }}
        />
      </label>
      <button
        className="mt-4 rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-stone-400"
        disabled={!file || busy}
        onClick={stage}
        type="button"
      >
        {busy ? "Staging…" : "Stage for review"}
      </button>
      {error && <p className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-800">{error}</p>}

      {result && (
        <div className="mt-6 border-t border-stone-200 pt-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">Step 2 — review the hold list</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <Stat label="Rows staged" value={result.importRun.rowCount} tone="stone" />
            <Stat label="Data gaps" value={result.importRun.dataGapCount} tone={result.importRun.dataGapCount ? "amber" : "green"} />
            <Stat label="Project conflicts" value={result.importRun.conflictCount} tone={result.importRun.conflictCount ? "red" : "green"} />
          </div>
          <p className="mt-4 text-sm font-medium text-stone-900">Nothing is committed from this screen yet.</p>
          <div className="mt-3 overflow-x-auto rounded-lg border border-stone-200">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-stone-50 text-stone-600"><tr><th className="px-3 py-2">Row</th><th className="px-3 py-2">Material</th><th className="px-3 py-2">Source job</th><th className="px-3 py-2">Check</th></tr></thead>
              <tbody>
                {(result.reviewRows ?? []).map((row) => <tr className="border-t border-stone-100" key={row.rowNumber}>
                  <td className="px-3 py-2 text-stone-600">{row.rowNumber}</td><td className="px-3 py-2 font-medium text-stone-900">{row.description}</td><td className="px-3 py-2 text-stone-600">{row.sourceProjectRef || "Missing — data gap"}</td><td className="px-3 py-2"><Status state={row.validationState} /></td>
                </tr>)}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: "stone" | "green" | "amber" | "red" }) {
  const tones = { stone: "bg-stone-50 text-stone-900", green: "bg-emerald-50 text-emerald-900", amber: "bg-amber-50 text-amber-900", red: "bg-red-50 text-red-900" };
  return <div className={`rounded-lg p-3 ${tones[tone]}`}><p className="text-xs font-medium">{label}</p><p className="text-2xl font-semibold">{value}</p></div>;
}

function Status({ state }: { state: ReviewRow["validationState"] }) {
  const label = state === "READY" ? "Ready" : state === "DATA_GAP" ? "Data gap" : "Project conflict";
  const color = state === "READY" ? "bg-emerald-100 text-emerald-800" : state === "DATA_GAP" ? "bg-amber-100 text-amber-800" : "bg-red-100 text-red-800";
  return <span className={`rounded-full px-2 py-1 text-xs font-medium ${color}`}>{label}</span>;
}
