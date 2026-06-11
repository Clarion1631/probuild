"use client";

// Settings > Design Catalog - the org's real-product library for Room Studio.
// Import vendor catalogs (paste text or drop a PDF), review what the AI
// extracted, save selected entries, and manage what's already in the library.

import { useCallback, useEffect, useRef, useState } from "react";
import { Trash2, Upload, Sparkles, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";

interface LibFinish {
  id: string;
  kind: string;
  name: string;
  hex: string;
  vendor?: string | null;
  priceNote?: string | null;
}

interface LibProduct {
  id: string;
  name: string;
  vendor?: string | null;
  sku?: string | null;
  category: string;
  mesh: string;
  widthIn: number;
  depthIn: number;
  heightIn: number;
  price?: number | null;
}

interface Candidates {
  finishes: Array<Record<string, unknown> & { name?: string; kind?: string; hex?: string; vendor?: string }>;
  products: Array<Record<string, unknown> & { name?: string; category?: string; widthIn?: number; price?: number; vendor?: string }>;
}

const KIND_LABELS: Record<string, string> = {
  cabinet: "Cabinet line",
  paint: "Paint",
  floor: "Flooring",
  counter: "Countertop",
  tile: "Tile",
};

export default function CatalogSettingsClient() {
  const [finishes, setFinishes] = useState<LibFinish[]>([]);
  const [products, setProducts] = useState<LibProduct[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/studio-library");
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      setFinishes(data.finishes ?? []);
      setProducts(data.products ?? []);
    } catch {
      toast.error("Couldn't load the catalog library");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const removeFinish = async (id: string) => {
    await fetch(`/api/studio-library?finishId=${id}`, { method: "DELETE" });
    setFinishes((fs) => fs.filter((f) => f.id !== id));
  };

  const removeProduct = async (id: string) => {
    await fetch(`/api/studio-library?productId=${id}`, { method: "DELETE" });
    setProducts((ps) => ps.filter((p) => p.id !== id));
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div>
        <h1 className="text-xl font-bold text-slate-800">Design Catalog</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          Your real vendors&apos; cabinet lines, paints, flooring, and products - available in every Room
          Studio design and priced into estimate takeoffs.
        </p>
      </div>

      <Importer onSaved={load} />

      <section className="rounded-2xl border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-bold text-slate-700">Finishes &amp; color lines ({finishes.length})</h2>
        {loading ? (
          <div className="py-6 text-center text-sm text-slate-400">Loading...</div>
        ) : finishes.length === 0 ? (
          <p className="mt-2 text-xs text-slate-400">
            Nothing yet - import a vendor catalog above, or add Sherwin-Williams colors right from the
            studio&apos;s Paint tab (those are built in).
          </p>
        ) : (
          <div className="mt-3 grid gap-1.5 sm:grid-cols-2">
            {finishes.map((f) => (
              <div key={f.id} className="group flex items-center gap-2.5 rounded-lg border border-slate-100 px-2.5 py-2">
                <span className="h-7 w-7 shrink-0 rounded-md border border-black/10" style={{ backgroundColor: f.hex }} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-semibold text-slate-700">{f.name}</div>
                  <div className="truncate text-[10px] text-slate-400">
                    {KIND_LABELS[f.kind] ?? f.kind}
                    {f.vendor ? ` - ${f.vendor}` : ""}
                    {f.priceNote ? ` - ${f.priceNote}` : ""}
                  </div>
                </div>
                <button
                  onClick={() => removeFinish(f.id)}
                  className="rounded p-1.5 text-slate-300 opacity-0 transition group-hover:opacity-100 hover:bg-red-50 hover:text-red-500"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-bold text-slate-700">Products ({products.length})</h2>
        {products.length === 0 ? (
          <p className="mt-2 text-xs text-slate-400">
            Sized, purchasable items (a specific 36&quot; sink base, a vanity, an appliance). They show in
            the studio with a &quot;Yours&quot; badge and carry their real price into estimates.
          </p>
        ) : (
          <div className="mt-3 space-y-1.5">
            {products.map((p) => (
              <div key={p.id} className="group flex items-center gap-3 rounded-lg border border-slate-100 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-semibold text-slate-700">{p.name}</div>
                  <div className="truncate text-[10px] text-slate-400">
                    {p.widthIn}&quot;W x {p.heightIn}&quot;H x {p.depthIn}&quot;D - {p.category}
                    {p.vendor ? ` - ${p.vendor}` : ""}{p.sku ? ` - ${p.sku}` : ""}
                  </div>
                </div>
                {p.price != null && <span className="text-xs font-bold text-slate-600">${Number(p.price).toLocaleString()}</span>}
                <button
                  onClick={() => removeProduct(p.id)}
                  className="rounded p-1.5 text-slate-300 opacity-0 transition group-hover:opacity-100 hover:bg-red-50 hover:text-red-500"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Importer({ onSaved }: { onSaved: () => void }) {
  const [text, setText] = useState("");
  const [vendor, setVendor] = useState("");
  const [busy, setBusy] = useState<"extract" | "save" | null>(null);
  const [candidates, setCandidates] = useState<Candidates | null>(null);
  const [checkedF, setCheckedF] = useState<Set<number>>(new Set());
  const [checkedP, setCheckedP] = useState<Set<number>>(new Set());
  const fileRef = useRef<HTMLInputElement>(null);

  const onPdf = async (file: File) => {
    setBusy("extract");
    try {
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/build/pdf.worker.min.mjs",
        import.meta.url,
      ).toString();
      const buf = await file.arrayBuffer();
      const doc = await pdfjs.getDocument({ data: buf }).promise;
      let out = "";
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        out += content.items.map((it) => ("str" in it ? it.str : "")).join(" ") + "\n";
      }
      setText(out.trim());
      toast.success(`Read ${doc.numPages} pages - now hit Extract`);
    } catch {
      toast.error("Couldn't read that PDF here - copy/paste its text instead");
    } finally {
      setBusy(null);
    }
  };

  const extract = async () => {
    setBusy("extract");
    setCandidates(null);
    try {
      const res = await fetch("/api/studio-library/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, vendor: vendor || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? String(res.status));
      setCandidates(data);
      setCheckedF(new Set(data.finishes.map((_: unknown, i: number) => i)));
      setCheckedP(new Set(data.products.map((_: unknown, i: number) => i)));
      toast.success(`Found ${data.finishes.length} finishes and ${data.products.length} products`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Extraction failed");
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!candidates) return;
    setBusy("save");
    try {
      const res = await fetch("/api/studio-library", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          finishes: candidates.finishes.filter((_, i) => checkedF.has(i)),
          products: candidates.products.filter((_, i) => checkedP.has(i)),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? String(res.status));
      toast.success(`Saved ${data.finishes} finishes and ${data.products} products to your library`);
      setCandidates(null);
      setText("");
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(null);
    }
  };

  const toggle = (set: Set<number>, i: number, apply: (s: Set<number>) => void) => {
    const next = new Set(set);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    apply(next);
  };

  return (
    <section className="rounded-2xl border border-blue-100 bg-blue-50/40 p-5">
      <h2 className="flex items-center gap-1.5 text-sm font-bold text-slate-700">
        <Sparkles className="h-4 w-4 text-blue-600" />
        Import a vendor catalog
      </h2>
      <p className="mt-1 text-xs leading-relaxed text-slate-500">
        Drop a catalog PDF or paste any product text (a Home Depot / Lowe&apos;s product page, a spec
        sheet, a price list). AI extracts the color lines and sized products, you review, then save.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onPdf(f);
            e.target.value = "";
          }}
        />
        <button
          onClick={() => fileRef.current?.click()}
          disabled={busy !== null}
          className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          <Upload className="h-3.5 w-3.5" />
          Read a PDF
        </button>
        <input
          value={vendor}
          onChange={(e) => setVendor(e.target.value)}
          placeholder="Vendor name (optional, e.g. TheRTAStore)"
          className="w-64 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs outline-none focus:border-blue-400"
        />
      </div>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="...or paste catalog / product page text here"
        rows={5}
        className="mt-2 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono text-[11px] outline-none focus:border-blue-400"
      />

      <button
        onClick={extract}
        disabled={busy !== null || text.trim().length < 40}
        className="mt-2 flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-xs font-bold text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {busy === "extract" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
        {busy === "extract" ? "Working..." : "Extract with AI"}
      </button>

      {candidates && (
        <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
          <h3 className="text-xs font-bold text-slate-700">
            Review: {candidates.finishes.length} finishes, {candidates.products.length} products
          </h3>
          <div className="mt-2 max-h-72 space-y-1 overflow-y-auto">
            {candidates.finishes.map((f, i) => (
              <label key={`f${i}`} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-slate-50">
                <input type="checkbox" checked={checkedF.has(i)} onChange={() => toggle(checkedF, i, setCheckedF)} className="accent-blue-600" />
                <span className="h-4 w-4 rounded border border-black/10" style={{ backgroundColor: String(f.hex ?? "#ccc") }} />
                <span className="font-semibold text-slate-700">{String(f.name ?? "?")}</span>
                <span className="text-slate-400">{KIND_LABELS[String(f.kind)] ?? String(f.kind)}{f.vendor ? ` - ${f.vendor}` : ""}</span>
              </label>
            ))}
            {candidates.products.map((p, i) => (
              <label key={`p${i}`} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-slate-50">
                <input type="checkbox" checked={checkedP.has(i)} onChange={() => toggle(checkedP, i, setCheckedP)} className="accent-blue-600" />
                <Plus className="h-3 w-3 text-slate-300" />
                <span className="font-semibold text-slate-700">{String(p.name ?? "?")}</span>
                <span className="text-slate-400">
                  {String(p.category)} {p.widthIn ? `- ${p.widthIn}"w` : ""} {p.price != null ? `- $${p.price}` : ""}
                </span>
              </label>
            ))}
          </div>
          <button
            onClick={save}
            disabled={busy !== null}
            className="mt-3 flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-bold text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {busy === "save" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Save selected to library
          </button>
        </div>
      )}
    </section>
  );
}
