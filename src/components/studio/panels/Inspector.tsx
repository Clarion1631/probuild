"use client";

// Room Studio - right panel: properties for the selected item or surface.

import { useMemo, useState, useEffect } from "react";
import { RotateCw, Copy, Trash2, ArrowUpDown } from "lucide-react";
import { toast } from "sonner";
import { getItemDef } from "@/lib/studio/catalog";
import {
  PAINTS, SW_PAINTS, FLOORS, COUNTERS, CABINET_FINISHES, METALS, FABRICS, WOODS, TILES,
  getFinish, getLibraryFinishesByKind, type Finish,
} from "@/lib/studio/materials";
import { formatFtIn, inches, toInches, parseFtIn } from "@/lib/studio/units";
import { wallSegments, signedArea, removeCornerFromPolygon } from "@/lib/studio/geometry";
import { useStudio, useSelectedItem } from "../store";
import { useLibrary } from "../useLibrary";
import { Swatch, PaintSections } from "./CatalogPanel";

const SLOT_LABELS: Record<string, string> = {
  cabinet: "Cabinet color",
  counter: "Countertop",
  hardware: "Hardware",
  metal: "Metal finish",
  sink: "Sink",
  faucet: "Faucet",
  fabric: "Fabric",
  legs: "Legs",
  wood: "Wood",
  frame: "Frame",
  door: "Door color",
  shade: "Shade",
  basin: "Basin",
  tile: "Tile",
  surround: "Surround",
  mantel: "Mantel",
};

function optionsForSlot(slot: string): Finish[] {
  switch (slot) {
    case "cabinet": return [...getLibraryFinishesByKind("cabinet"), ...CABINET_FINISHES];
    case "counter": return [...getLibraryFinishesByKind("counter"), ...COUNTERS];
    case "hardware":
    case "metal":
    case "sink":
    case "faucet": return METALS;
    case "fabric":
    case "shade": return FABRICS;
    case "legs":
    case "wood":
    case "mantel":
    case "frame": return [...WOODS, ...METALS.slice(0, 4), ...PAINTS.slice(0, 6)];
    case "door": return PAINTS;
    case "paint": return [...getLibraryFinishesByKind("paint"), ...PAINTS, ...SW_PAINTS];
    case "basin": return CABINET_FINISHES.slice(0, 6);
    case "tile":
    case "surround": return [...getLibraryFinishesByKind("tile"), ...TILES];
    default: return PAINTS;
  }
}

export function Inspector() {
  const item = useSelectedItem();
  const activeSurface = useStudio((s) => s.activeSurface);

  if (item) return <ItemInspector key={item.id} />;
  if (activeSurface) return <SurfaceInspector />;
  return null;
}

function ItemInspector() {
  const item = useSelectedItem();
  const updateItem = useStudio((s) => s.updateItem);
  const removeItem = useStudio((s) => s.removeItem);
  const duplicateItem = useStudio((s) => s.duplicateItem);
  useLibrary(); // finish options include the org library once loaded

  const def = useMemo(() => (item ? getItemDef(item.defId) : undefined), [item]);
  if (!item || !def) return null;

  const w = item.w ?? def.w;
  const h = item.h ?? def.h;
  const elevation = item.y ?? def.elevation ?? 0;
  const finishes = { ...def.finishes, ...item.finishes };
  const slots = Object.keys(def.finishes ?? {});

  const stepW = (dir: 1 | -1) => {
    if (!def.resizable) return;
    const step = def.resizable.step ?? inches(3);
    const next = Math.min(def.resizable.max, Math.max(def.resizable.min, w + dir * step));
    if (def.resizable.axis === "wd") {
      const ratio = (item.d ?? def.d) / w;
      updateItem(item.id, { w: next, d: next * ratio });
    } else {
      updateItem(item.id, { w: next });
    }
  };

  return (
    <div className="flex h-full w-[270px] shrink-0 flex-col overflow-y-auto border-l border-slate-200 bg-white">
      <div className="border-b border-slate-100 p-3.5">
        <div className="text-sm font-bold text-slate-800">{item.label ?? def.name}</div>
        <div className="mt-0.5 text-[11px] text-slate-400">
          {formatFtIn(w)} w x {formatFtIn(item.d ?? def.d)} d x {formatFtIn(h)} h
        </div>
        <div className="mt-2.5 flex gap-1.5">
          <ActionButton
            title="Rotate 90 (R)"
            onClick={() => updateItem(item.id, { rotation: item.rotation + Math.PI / 2 })}
          >
            <RotateCw className="h-3.5 w-3.5" />
          </ActionButton>
          <ActionButton title="Duplicate (Ctrl+D)" onClick={() => duplicateItem(item.id)}>
            <Copy className="h-3.5 w-3.5" />
          </ActionButton>
          <ActionButton title="Delete (Del)" danger onClick={() => removeItem(item.id)}>
            <Trash2 className="h-3.5 w-3.5" />
          </ActionButton>
        </div>
      </div>

      {def.resizable && (
        <Row label="Width">
          <div className="flex items-center gap-1">
            <Stepper onClick={() => stepW(-1)}>-</Stepper>
            <span className="min-w-[64px] text-center text-xs font-semibold text-slate-700">{formatFtIn(w)}</span>
            <Stepper onClick={() => stepW(1)}>+</Stepper>
          </div>
        </Row>
      )}

      {(def.mount === "wall" && def.category !== "doors-windows") && (
        <Row label="Height off floor" icon={<ArrowUpDown className="h-3 w-3" />}>
          <input
            type="range"
            min={0}
            max={84}
            step={1}
            value={Math.round(toInches(elevation))}
            onChange={(e) => updateItem(item.id, { y: inches(Number(e.target.value)) })}
            className="w-28 accent-blue-600"
          />
          <span className="ml-1.5 w-10 text-right text-[11px] font-medium text-slate-600">
            {Math.round(toInches(elevation))}&quot;
          </span>
        </Row>
      )}

      {def.category === "doors-windows" && def.id.startsWith("window") && (
        <Row label="Sill height">
          <input
            type="range"
            min={0}
            max={48}
            step={1}
            value={Math.round(toInches(elevation))}
            onChange={(e) => updateItem(item.id, { y: inches(Number(e.target.value)) })}
            className="w-28 accent-blue-600"
          />
          <span className="ml-1.5 w-10 text-right text-[11px] font-medium text-slate-600">
            {Math.round(toInches(elevation))}&quot;
          </span>
        </Row>
      )}

      {slots.map((slot) => (
        <div key={slot} className="border-b border-slate-50 px-3.5 py-2.5">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
              {SLOT_LABELS[slot] ?? slot}
            </span>
            <span className="text-[10px] text-slate-400">{getFinish(finishes[slot], "cab-white").name}</span>
          </div>
          <div className="grid grid-cols-6 gap-1">
            {optionsForSlot(slot).map((f) => (
              <button
                key={f.id}
                title={f.name}
                onClick={() => updateItem(item.id, { finishes: { ...item.finishes, [slot]: f.id } })}
                className={`h-7 rounded-md border border-black/10 transition-transform hover:scale-110 ${
                  finishes[slot] === f.id ? "ring-2 ring-blue-500 ring-offset-1" : ""
                }`}
                style={{ backgroundColor: f.hex }}
              />
            ))}
          </div>
        </div>
      ))}

      <div className="px-3.5 py-3 text-[10.5px] leading-relaxed text-slate-400">
        Drag the piece to move it - it snaps to walls and lines up with neighbors.
        Drag the blue dot to spin it. Press <b>R</b> to rotate 90.
      </div>
    </div>
  );
}

function SurfaceInspector() {
  const activeSurface = useStudio((s) => s.activeSurface);
  const doc = useStudio((s) => s.doc);
  const docRev = useStudio((s) => s.docRev);
  const setWallPaint = useStudio((s) => s.setWallPaint);
  const setFloorFinish = useStudio((s) => s.setFloorFinish);

  if (!activeSurface) return null;

  if (activeSurface.kind === "corner") {
    return <CornerInspector index={activeSurface.index} />;
  }

  if (activeSurface.kind === "floor") {
    return (
      <div className="flex h-full w-[270px] shrink-0 flex-col overflow-y-auto border-l border-slate-200 bg-white">
        <div className="border-b border-slate-100 p-3.5">
          <div className="text-sm font-bold text-slate-800">Floor</div>
          <div className="mt-0.5 text-[11px] text-slate-400">{getFinish(doc.surfaces.floor, "floor-oak-natural").name}</div>
        </div>
        <div className="grid grid-cols-4 gap-1.5 p-3">
          {FLOORS.map((f) => (
            <Swatch key={f.id} hex={f.hex} name={f.name} selected={doc.surfaces.floor === f.id} onClick={() => setFloorFinish(f.id)} />
          ))}
        </div>
      </div>
    );
  }

  const wallIdx = activeSurface.wallIndex;
  const currentId = doc.surfaces.walls[String(wallIdx)] ?? doc.surfaces.walls.all;

  return (
    <div className="flex h-full w-[270px] shrink-0 flex-col overflow-y-auto border-l border-slate-200 bg-white">
      <div className="border-b border-slate-100 p-3.5">
        <div className="text-sm font-bold text-slate-800">Wall {wallIdx + 1}</div>
        <div className="mt-0.5 text-[11px] text-slate-400">{getFinish(currentId, "paint-soft-chalk").name}</div>
        <button
          onClick={() => currentId && setWallPaint("all", currentId)}
          className="mt-2 rounded-md bg-slate-100 px-2.5 py-1.5 text-[11px] font-semibold text-slate-600 hover:bg-slate-200"
        >
          Apply this color to every wall
        </button>
      </div>
      {/* keyed by edit revision: input text re-derives after every commit */}
      <WallLengthEditor key={`${wallIdx}:${docRev}`} wallIdx={wallIdx} />
      <div className="p-3">
        <PaintSections currentId={currentId} onPick={(id) => setWallPaint(wallIdx, id)} />
      </div>
    </div>
  );
}

function CornerInspector({ index }: { index: number }) {
  const doc = useStudio((s) => s.doc);
  const setRoomShape = useStudio((s) => s.setRoomShape);
  const setActiveSurface = useStudio((s) => s.setActiveSurface);
  const p = doc.room.points[index];
  if (!p) return null;

  const removable = removeCornerFromPolygon(doc.room.points, index) !== null;

  const remove = () => {
    const next = removeCornerFromPolygon(doc.room.points, index);
    if (!next) {
      toast.error("This corner can't be removed - the room would collapse");
      return;
    }
    setRoomShape({
      ...doc.room,
      points: next,
      slope: next.length === 4 ? doc.room.slope : undefined,
    });
    setActiveSurface(null);
    toast.success("Corner removed - Ctrl+Z to undo");
  };

  return (
    <div className="flex h-full w-[270px] shrink-0 flex-col overflow-y-auto border-l border-slate-200 bg-white">
      <div className="border-b border-slate-100 p-3.5">
        <div className="text-sm font-bold text-slate-800">Corner {index + 1}</div>
        <div className="mt-0.5 text-[11px] text-slate-400">
          {formatFtIn(p.x)} , {formatFtIn(p.z)} from room center
        </div>
      </div>
      <div className="p-3.5">
        <button
          onClick={remove}
          disabled={!removable}
          className="w-full rounded-lg border border-red-200 py-2 text-xs font-bold text-red-600 hover:bg-red-50 disabled:opacity-40 disabled:hover:bg-transparent"
        >
          Remove corner (merge the two walls)
        </button>
        <p className="mt-2.5 text-[10.5px] leading-relaxed text-slate-400">
          Drag the dot to move this corner - it snaps square to neighboring corners.
          Removing it joins the two walls that meet here into one straight wall.
          You can also press <b>Del</b> while it&apos;s selected.
        </p>
      </div>
    </div>
  );
}

/** Exact wall length editing: typing a new length slides the wall's far
    corner along the wall direction (the next wall adjusts automatically). */
function WallLengthEditor({ wallIdx }: { wallIdx: number }) {
  const doc = useStudio((s) => s.doc);
  const setRoomShape = useStudio((s) => s.setRoomShape);
  const walls = useMemo(() => wallSegments(doc.room.points), [doc.room.points]);
  const wall = walls[wallIdx];
  // Parent keys this component by edit revision, so lazy init stays fresh.
  const [text, setText] = useState(() => (wall ? formatFtIn(wall.length) : ""));

  if (!wall) return null;

  const apply = () => {
    const next = parseFtIn(text);
    if (next === null) {
      setText(formatFtIn(wall.length));
      return;
    }
    const len = Math.min(inches(720), Math.max(inches(12), next));
    const points = doc.room.points.map((p) => ({ ...p }));
    const j = (wallIdx + 1) % points.length;
    points[j] = {
      x: wall.a.x + wall.dir.x * len,
      z: wall.a.z + wall.dir.z * len,
    };
    // reject degenerate results (the FOLLOWING wall absorbs the change)
    const k = (j + 1) % points.length;
    const nextLen = Math.hypot(points[k].x - points[j].x, points[k].z - points[j].z);
    if (nextLen < inches(12) || Math.abs(signedArea(points)) < 0.75) {
      toast.error("That length would collapse the next wall");
      setText(formatFtIn(wall.length));
      return;
    }
    setRoomShape({ ...doc.room, points });
  };

  return (
    <div className="flex items-center justify-between border-b border-slate-100 px-3.5 py-2.5">
      <span className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Length</span>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={apply}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className="w-24 rounded-md border border-slate-200 px-2 py-1.5 text-right text-xs outline-none focus:border-blue-400"
      />
    </div>
  );
}

function Row({ label, icon, children }: { label: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-slate-50 px-3.5 py-2.5">
      <span className="flex items-center gap-1 text-[11px] font-bold uppercase tracking-wide text-slate-500">
        {icon}
        {label}
      </span>
      <div className="flex items-center">{children}</div>
    </div>
  );
}

function Stepper({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded-md bg-slate-100 text-sm font-bold text-slate-600 hover:bg-slate-200 active:scale-95"
    >
      {children}
    </button>
  );
}

function ActionButton({ children, title, onClick, danger }: {
  children: React.ReactNode; title: string; onClick: () => void; danger?: boolean;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={`flex h-8 w-8 items-center justify-center rounded-lg border transition-colors ${
        danger
          ? "border-red-200 text-red-500 hover:bg-red-50"
          : "border-slate-200 text-slate-600 hover:bg-slate-100"
      }`}
    >
      {children}
    </button>
  );
}
