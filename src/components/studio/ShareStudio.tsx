"use client";

// Room Studio - public read-only viewer for client share links.
// Same canvas, no editing chrome: orbit/walk toggle, lights, branding,
// plus a photo-renders strip when AI renders exist.

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { Lightbulb, LightbulbOff, Box as BoxIcon, Footprints, Map as MapIcon, Image as ImageIcon, X } from "lucide-react";
import type { DesignDoc } from "@/lib/studio/doc";
import { useStudio, type ViewMode } from "./store";

const StudioCanvasNoSsr = dynamic(
  () => import("./canvas/StudioCanvas").then((m) => m.StudioCanvas),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full w-full items-center justify-center bg-slate-100 text-sm text-slate-400">
        Loading your design...
      </div>
    ),
  },
);

export interface ShareStudioProps {
  doc: DesignDoc;
  roomName: string;
  ownerName: string;
  contractor: { name: string; logoUrl: string | null };
  renders?: Array<{ id: string; url: string }>;
  arUsdzUrl?: string | null;
}

export default function ShareStudio({ doc, roomName, ownerName, contractor, renders = [], arUsdzUrl }: ShareStudioProps) {
  // AR Quick Look only exists on iOS Safari - show the button there only.
  const [isIOS, setIsIOS] = useState(false);
  useEffect(() => {
    setIsIOS(/iPhone|iPad/.test(navigator.userAgent));
  }, []);
  const loadDoc = useStudio((s) => s.loadDoc);
  const setPresentMode = useStudio((s) => s.setPresentMode);
  const view = useStudio((s) => s.view);
  const setView = useStudio((s) => s.setView);
  const lightsOn = useStudio((s) => s.lightsOn);
  const setLightsOn = useStudio((s) => s.setLightsOn);

  useEffect(() => {
    loadDoc(doc);
    setPresentMode(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex h-dvh w-full flex-col bg-slate-100">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2.5">
        <div className="flex items-center gap-3">
          {contractor.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={contractor.logoUrl} alt={contractor.name} className="h-8 w-8 rounded object-contain" />
          ) : (
            <div className="flex h-8 w-8 items-center justify-center rounded bg-blue-600 text-sm font-bold text-white">
              {contractor.name.slice(0, 1)}
            </div>
          )}
          <div>
            <div className="text-sm font-bold leading-tight text-slate-800">{roomName}</div>
            <div className="text-[11px] leading-tight text-slate-400">
              {ownerName} - designed by {contractor.name}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {arUsdzUrl && isIOS && (
            <a
              href={arUsdzUrl}
              rel="ar"
              className="flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-bold text-white"
            >
              {/* AR Quick Look requires an <img> as the anchor's first child */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==" alt="" width={1} height={1} />
              View in AR
            </a>
          )}
          <button
            onClick={() => setLightsOn(!lightsOn)}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50"
            title="Toggle lights"
          >
            {lightsOn ? <Lightbulb className="h-4 w-4 text-amber-500" /> : <LightbulbOff className="h-4 w-4" />}
          </button>
          <div className="flex rounded-lg bg-slate-100 p-0.5">
            {([
              ["plan", "Plan", <MapIcon key="p" className="h-3.5 w-3.5" />],
              ["orbit", "3D", <BoxIcon key="o" className="h-3.5 w-3.5" />],
              ["walk", "Walk", <Footprints key="w" className="h-3.5 w-3.5" />],
            ] as Array<[ViewMode, string, React.ReactNode]>).map(([v, label, icon]) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                  view === v ? "bg-white text-blue-700 shadow-sm" : "text-slate-500 hover:text-slate-800"
                }`}
              >
                {icon}
                {label}
              </button>
            ))}
          </div>
        </div>
      </header>
      <div className="relative min-h-0 flex-1">
        <StudioCanvasNoSsr />
        <div className="pointer-events-none absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full bg-slate-900/70 px-4 py-1.5 text-[11px] font-medium text-white backdrop-blur">
          {view === "walk" ? "Drag to look around - W A S D keys to walk" : "Drag to spin - scroll to zoom"}
        </div>
      </div>
      {renders.length > 0 && <RendersStrip renders={renders} />}
    </div>
  );
}

/** Horizontal strip of AI photo renders with a tap-to-enlarge lightbox. */
function RendersStrip({ renders }: { renders: Array<{ id: string; url: string }> }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <div className="border-t border-slate-200 bg-white px-4 py-2.5">
        <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-500">
          <ImageIcon className="h-3.5 w-3.5" />
          Photo renders
        </div>
        <div className="flex gap-2 overflow-x-auto pb-1">
          {renders.map((r) => (
            <button key={r.id} onClick={() => setOpen(r.url)} className="shrink-0" title="View full size">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={r.url}
                alt="Photorealistic room render"
                className="h-20 rounded-lg border border-slate-200 object-cover transition hover:brightness-95"
                loading="lazy"
              />
            </button>
          ))}
        </div>
      </div>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/80 p-4"
          onClick={() => setOpen(null)}
        >
          <button
            className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full bg-white/15 text-white hover:bg-white/30"
            onClick={() => setOpen(null)}
          >
            <X className="h-5 w-5" />
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={open} alt="Photorealistic room render" className="max-h-full max-w-full rounded-xl shadow-2xl" />
        </div>
      )}
    </>
  );
}
