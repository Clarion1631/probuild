"use client";

// Room Studio - top toolbar: navigation, view modes, room size, undo/redo,
// lights, snapshot, share, present mode, save status.

import { useState, useRef, useEffect } from "react";
import {
  ArrowLeft, Undo2, Redo2, Camera, Share2, Lightbulb, LightbulbOff,
  Presentation, Map as MapIcon, Box as BoxIcon, Footprints, Ruler, Check, Loader2, AlertTriangle,
  Square,
} from "lucide-react";
import { toast } from "sonner";
import { feet, parseFtIn, formatFtIn } from "@/lib/studio/units";
import { makeRectRoom, makeLShapeRoom } from "@/lib/studio/doc";
import { polygonBounds, squareUpPolygon } from "@/lib/studio/geometry";
import { useStudio, type ViewMode } from "./store";
import { captureSnapshot, downloadDataUrl } from "./snapshot";

export function TopBar({
  roomName, backHref, onShare,
}: {
  roomName: string;
  backHref: string;
  onShare: () => void;
}) {
  const view = useStudio((s) => s.view);
  const setView = useStudio((s) => s.setView);
  const lightsOn = useStudio((s) => s.lightsOn);
  const setLightsOn = useStudio((s) => s.setLightsOn);
  const presentMode = useStudio((s) => s.presentMode);
  const setPresentMode = useStudio((s) => s.setPresentMode);
  const undo = useStudio((s) => s.undo);
  const redo = useStudio((s) => s.redo);
  const canUndo = useStudio((s) => s.undoStack.length > 0);
  const canRedo = useStudio((s) => s.redoStack.length > 0);
  const saveState = useStudio((s) => s.saveState);

  const snapshot = () => {
    const result = captureSnapshot({ width: 2560 });
    if (!result) {
      toast.error("Couldn't capture - canvas not ready");
      return;
    }
    const stamp = new Date().toISOString().slice(0, 10);
    downloadDataUrl(result.dataUrl, `${roomName.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${stamp}.png`);
    toast.success("Snapshot saved to downloads");
  };

  if (presentMode) {
    return (
      <div className="absolute left-0 right-0 top-0 z-20 flex items-center justify-between px-4 py-3">
        <div className="rounded-full bg-white/85 px-4 py-1.5 text-sm font-semibold text-slate-700 shadow backdrop-blur">
          {roomName}
        </div>
        <div className="flex items-center gap-2">
          <ViewToggle view={view} setView={setView} floating />
          <button
            onClick={() => setPresentMode(false)}
            className="rounded-full bg-slate-900/85 px-4 py-1.5 text-sm font-semibold text-white shadow backdrop-blur hover:bg-slate-800"
          >
            Exit presentation
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-[52px] shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-3">
      <a
        href={backHref}
        className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100"
        title="Back to rooms"
      >
        <ArrowLeft className="h-4 w-4" />
      </a>
      <div className="min-w-0">
        <div className="truncate text-sm font-bold text-slate-800">{roomName}</div>
      </div>

      <div className="mx-2 h-6 w-px bg-slate-200" />

      <ViewToggle view={view} setView={setView} />

      <RoomSizeButton />

      <div className="mx-2 h-6 w-px bg-slate-200" />

      <IconButton title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={undo}>
        <Undo2 className="h-4 w-4" />
      </IconButton>
      <IconButton title="Redo (Ctrl+Y)" disabled={!canRedo} onClick={redo}>
        <Redo2 className="h-4 w-4" />
      </IconButton>

      <IconButton title={lightsOn ? "Turn lights off" : "Turn lights on"} onClick={() => setLightsOn(!lightsOn)}>
        {lightsOn ? <Lightbulb className="h-4 w-4 text-amber-500" /> : <LightbulbOff className="h-4 w-4" />}
      </IconButton>

      <div className="flex-1" />

      <SaveBadge state={saveState} />

      <button
        onClick={snapshot}
        className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
      >
        <Camera className="h-3.5 w-3.5" />
        Snapshot
      </button>

      <button
        onClick={() => setPresentMode(true)}
        className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
        title="Clean full-screen view for client meetings"
      >
        <Presentation className="h-3.5 w-3.5" />
        Present
      </button>

      <button
        onClick={onShare}
        className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-1.5 text-xs font-bold text-white hover:bg-blue-700"
      >
        <Share2 className="h-3.5 w-3.5" />
        Share
      </button>
    </div>
  );
}

function ViewToggle({ view, setView, floating }: { view: ViewMode; setView: (v: ViewMode) => void; floating?: boolean }) {
  const opts: Array<[ViewMode, string, React.ReactNode]> = [
    ["plan", "Plan", <MapIcon key="p" className="h-3.5 w-3.5" />],
    ["orbit", "3D", <BoxIcon key="o" className="h-3.5 w-3.5" />],
    ["walk", "Walk", <Footprints key="w" className="h-3.5 w-3.5" />],
  ];
  return (
    <div className={`flex rounded-lg p-0.5 ${floating ? "bg-white/85 shadow backdrop-blur" : "bg-slate-100"}`}>
      {opts.map(([v, label, icon]) => (
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
  );
}

const SLOPE_SIDES = ["North", "East", "South", "West"];

function RoomSizeButton() {
  const doc = useStudio((s) => s.doc);
  const setRoomShape = useStudio((s) => s.setRoomShape);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const bounds = polygonBounds(doc.room.points);
  const [wText, setWText] = useState("");
  const [lText, setLText] = useState("");
  const [hText, setHText] = useState("");
  const [lowText, setLowText] = useState("");

  const isRect = doc.room.points.length === 4;
  const slope = doc.room.slope;

  useEffect(() => {
    if (open) {
      setWText(formatFtIn(bounds.width));
      setLText(formatFtIn(bounds.length));
      setHText(formatFtIn(doc.room.height));
      setLowText(formatFtIn(doc.room.slope?.lowHeight ?? feet(5)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  // Scale the EXISTING polygon to the new bounding box - keeps custom and
  // angled shapes intact instead of resetting them.
  const applyDims = () => {
    const w = Math.min(feet(60), Math.max(feet(4), parseFtIn(wText) ?? bounds.width));
    const l = Math.min(feet(60), Math.max(feet(4), parseFtIn(lText) ?? bounds.length));
    const h = Math.min(feet(16), Math.max(feet(7), parseFtIn(hText) ?? doc.room.height));
    const sx = bounds.width > 0 ? w / bounds.width : 1;
    const sz = bounds.length > 0 ? l / bounds.length : 1;
    const points = doc.room.points.map((p) => ({
      x: (p.x - bounds.center.x) * sx,
      z: (p.z - bounds.center.z) * sz,
    }));
    setRoomShape({ ...doc.room, points, height: h });
    setOpen(false);
  };

  const resetLayout = (shape: "rect" | "l-shape") => {
    const w = Math.min(feet(60), Math.max(feet(4), parseFtIn(wText) ?? bounds.width));
    const l = Math.min(feet(60), Math.max(feet(4), parseFtIn(lText) ?? bounds.length));
    const h = Math.min(feet(16), Math.max(feet(7), parseFtIn(hText) ?? doc.room.height));
    const base = shape === "l-shape"
      ? makeLShapeRoom(w, l, w * 0.45, l * 0.45, h)
      : makeRectRoom(w, l, h);
    // slope only survives onto rect layouts
    setRoomShape({ ...base, crown: doc.room.crown, slope: shape === "rect" ? doc.room.slope : undefined });
  };

  const setCrown = (on: boolean) => setRoomShape({ ...doc.room, crown: on || undefined });

  const setSlopeSide = (idx: number | null) => {
    if (idx === null) {
      setRoomShape({ ...doc.room, slope: undefined });
    } else {
      const low = Math.min(doc.room.height - feet(1), Math.max(feet(3), parseFtIn(lowText) ?? feet(5)));
      setRoomShape({ ...doc.room, slope: { lowWallIndex: idx, lowHeight: low } });
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
      >
        <Ruler className="h-3.5 w-3.5" />
        {formatFtIn(bounds.width)} x {formatFtIn(bounds.length)}
      </button>
      {open && (
        <div className="absolute left-0 top-10 z-30 w-72 rounded-xl border border-slate-200 bg-white p-3.5 shadow-xl">
          <div className="mb-2 text-xs font-bold text-slate-700">Room size</div>
          <div className="space-y-2">
            <SizeInput label="Width" value={wText} onChange={setWText} />
            <SizeInput label="Length" value={lText} onChange={setLText} />
            <SizeInput label="Ceiling" value={hText} onChange={setHText} />
          </div>
          <div className="mt-1.5 text-[10px] text-slate-400">
            Formats like 12&apos;6&quot; or 150&quot;. Resizing keeps your wall shape - drag walls and corners directly in Plan view.
          </div>
          <button
            onClick={applyDims}
            className="mt-2 w-full rounded-lg bg-blue-600 py-2 text-xs font-bold text-white hover:bg-blue-700"
          >
            Apply size
          </button>

          <button
            onClick={() => {
              const squared = squareUpPolygon(doc.room.points);
              if (squared) {
                setRoomShape({ ...doc.room, points: squared });
                toast.success("Walls squared to 90°");
              } else {
                toast.error("Couldn't square these walls up - straighten the worst corner first");
              }
            }}
            className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-slate-200 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            title="Snap every nearly-straight wall to exact horizontal/vertical"
          >
            <Square className="h-3.5 w-3.5" />
            Square up walls
          </button>

          <div className="mt-3 border-t border-slate-100 pt-2.5">
            <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-500">Reset layout</div>
            <div className="flex gap-1">
              <button onClick={() => resetLayout("rect")} className="flex-1 rounded-md bg-slate-100 px-2 py-1.5 text-[11px] font-semibold text-slate-600 hover:bg-slate-200">
                Rectangle
              </button>
              <button onClick={() => resetLayout("l-shape")} className="flex-1 rounded-md bg-slate-100 px-2 py-1.5 text-[11px] font-semibold text-slate-600 hover:bg-slate-200">
                L-Shape
              </button>
            </div>
          </div>

          <div className="mt-3 border-t border-slate-100 pt-2.5">
            <label className="flex items-center justify-between">
              <span className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Crown molding</span>
              <input
                type="checkbox"
                checked={!!doc.room.crown}
                onChange={(e) => setCrown(e.target.checked)}
                className="h-4 w-4 accent-blue-600"
              />
            </label>
          </div>

          <div className="mt-3 border-t border-slate-100 pt-2.5">
            <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-500">Slanted ceiling</div>
            {isRect ? (
              <>
                <div className="flex gap-1">
                  <button
                    onClick={() => setSlopeSide(null)}
                    className={`flex-1 rounded-md px-1.5 py-1.5 text-[11px] font-semibold ${!slope ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
                  >
                    Off
                  </button>
                  {SLOPE_SIDES.map((label, idx) => (
                    <button
                      key={label}
                      onClick={() => setSlopeSide(idx)}
                      title={`Low side: ${label}`}
                      className={`flex-1 rounded-md px-1.5 py-1.5 text-[11px] font-semibold ${slope?.lowWallIndex === idx ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
                    >
                      {label[0]}
                    </button>
                  ))}
                </div>
                {slope && (
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <span className="text-[11px] font-semibold text-slate-500">Low-side height</span>
                    <input
                      value={lowText}
                      onChange={(e) => setLowText(e.target.value)}
                      onBlur={() => setSlopeSide(slope.lowWallIndex)}
                      onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") setSlopeSide(slope.lowWallIndex); }}
                      className="w-20 rounded-md border border-slate-200 px-2 py-1.5 text-right text-xs outline-none focus:border-blue-400"
                    />
                  </div>
                )}
              </>
            ) : (
              <div className="text-[10.5px] leading-snug text-slate-400">
                Available for 4-corner rectangular rooms.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SizeInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex items-center justify-between gap-2">
      <span className="text-[11px] font-semibold text-slate-500">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.stopPropagation()}
        className="w-24 rounded-md border border-slate-200 px-2 py-1.5 text-right text-xs outline-none focus:border-blue-400"
      />
    </label>
  );
}

function SaveBadge({ state }: { state: "saved" | "unsaved" | "saving" | "error" }) {
  const map = {
    saved: { icon: <Check className="h-3 w-3" />, text: "Saved", cls: "text-emerald-600" },
    unsaved: { icon: <Loader2 className="h-3 w-3" />, text: "Unsaved", cls: "text-slate-400" },
    saving: { icon: <Loader2 className="h-3 w-3 animate-spin" />, text: "Saving", cls: "text-blue-500" },
    error: { icon: <AlertTriangle className="h-3 w-3" />, text: "Save failed", cls: "text-red-500" },
  } as const;
  const m = map[state];
  return (
    <span className={`flex items-center gap-1 text-[11px] font-medium ${m.cls}`}>
      {m.icon}
      {m.text}
    </span>
  );
}

function IconButton({ children, title, onClick, disabled }: {
  children: React.ReactNode; title: string; onClick: () => void; disabled?: boolean;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      disabled={disabled}
      className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 disabled:opacity-30 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}
