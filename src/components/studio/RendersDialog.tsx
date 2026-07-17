"use client";

// Room Studio - AI photo renders gallery. Generate from the current camera
// view, browse past renders, open full size, delete.

import { useEffect, useState } from "react";
import { Sparkles, X, Trash2, ExternalLink, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { captureSnapshot } from "./snapshot";

interface RoomRender {
  id: string;
  url: string;
  createdAt: string;
}

export function RendersDialog({ roomId, onClose }: { roomId: string; onClose: () => void }) {
  const [renders, setRenders] = useState<RoomRender[] | null>(null);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch(`/api/rooms/${roomId}/render`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Couldn't load renders"))))
      .then((data) => { if (alive) setRenders(data.renders ?? []); })
      .catch(() => { if (alive) setRenders([]); });
    return () => { alive = false; };
  }, [roomId]);

  const generate = async () => {
    const shot = captureSnapshot({ width: 1600, format: "jpeg" });
    if (!shot) {
      toast.error("Couldn't capture the scene - canvas not ready");
      return;
    }
    setGenerating(true);
    try {
      const res = await fetch(`/api/rooms/${roomId}/render`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: shot.dataUrl }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Render failed");
      setRenders((prev) => [data.render, ...(prev ?? [])]);
      toast.success("Photo render ready");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Render failed");
    } finally {
      setGenerating(false);
    }
  };

  const remove = async (renderId: string) => {
    const prev = renders;
    setRenders((r) => (r ?? []).filter((x) => x.id !== renderId));
    const res = await fetch(`/api/rooms/${roomId}/render?renderId=${renderId}`, { method: "DELETE" });
    if (!res.ok) {
      setRenders(prev);
      toast.error("Couldn't delete render");
    }
  };

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-6" onClick={onClose}>
      <div
        className="flex max-h-full w-[760px] flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
          <div>
            <div className="text-sm font-bold text-slate-800">Photo renders</div>
            <div className="text-[11px] text-slate-400">
              AI re-renders your current camera view as a photorealistic photo - takes ~20 seconds
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={generate}
              disabled={generating}
              className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-1.5 text-xs font-bold text-white hover:bg-blue-700 disabled:opacity-60"
            >
              {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
              {generating ? "Rendering..." : "Render this view"}
            </button>
            <button onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="min-h-[200px] overflow-y-auto p-5">
          {renders === null ? (
            <div className="flex h-40 items-center justify-center text-slate-400">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : renders.length === 0 && !generating ? (
            <div className="flex h-40 flex-col items-center justify-center gap-1.5 text-center">
              <Sparkles className="h-6 w-6 text-slate-300" />
              <div className="text-sm font-semibold text-slate-600">No renders yet</div>
              <div className="max-w-[300px] text-[11.5px] text-slate-400">
                Frame the room the way you want it in 3D view, then hit &quot;Render this view&quot;.
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {generating && (
                <div className="flex aspect-video items-center justify-center rounded-xl border border-dashed border-blue-200 bg-blue-50/50">
                  <div className="flex flex-col items-center gap-2 text-blue-500">
                    <Loader2 className="h-5 w-5 animate-spin" />
                    <span className="text-[11px] font-semibold">Rendering...</span>
                  </div>
                </div>
              )}
              {renders.map((r) => (
                <div key={r.id} className="group relative overflow-hidden rounded-xl border border-slate-200">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={r.url} alt="Room render" className="aspect-video w-full object-cover" loading="lazy" />
                  <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-slate-900/70 to-transparent px-2.5 pb-2 pt-6 opacity-0 transition group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                    <span className="text-[10.5px] font-medium text-white/90">
                      {new Date(r.createdAt).toLocaleDateString()}
                    </span>
                    <div className="flex gap-1">
                      <a
                        href={r.url}
                        target="_blank"
                        rel="noreferrer"
                        className="flex h-7 w-7 items-center justify-center rounded-md bg-white/20 text-white backdrop-blur hover:bg-white/35"
                        title="Open full size"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                      <button
                        onClick={() => remove(r.id)}
                        className="flex h-7 w-7 items-center justify-center rounded-md bg-white/20 text-white backdrop-blur hover:bg-red-500/80"
                        title="Delete render"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="border-t border-slate-100 px-5 py-2.5 text-[10.5px] text-slate-400">
          Renders appear on the client share page automatically when sharing is on.
        </div>
      </div>
    </div>
  );
}
