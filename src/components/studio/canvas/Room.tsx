"use client";

// Room Studio - room shell: polygon floor, walls with door/window cutouts,
// per-wall paint, camera-facing wall auto-hide (dollhouse view).

import * as THREE from "three";
import { useMemo } from "react";
import { type ThreeEvent } from "@react-three/fiber";
import type { DesignDoc, PlacedItem } from "@/lib/studio/doc";
import { wallSegments, inwardLocalZ, type WallSeg } from "@/lib/studio/geometry";
import { getFinish } from "@/lib/studio/materials";
import { getItemDef } from "@/lib/studio/catalog";
import { useStudio } from "../store";

const WALL_FALLBACK = "paint-soft-chalk";
const CLICK_SLOP_PX = 5;

// ---------------------------------------------------------------------------
// Procedural floor textures (plank / tile), cached per finish id.
// ---------------------------------------------------------------------------

const floorTexCache = new Map<string, THREE.CanvasTexture>();

function floorTexture(finishId: string): THREE.CanvasTexture | null {
  if (typeof document === "undefined") return null;
  const cached = floorTexCache.get(finishId);
  if (cached) return cached;

  const f = getFinish(finishId, "floor-oak-natural");
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const base = f.hex;
  const accent = f.accentHex ?? f.hex;
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, 512, 512);

  const isTile = finishId.includes("tile") || finishId.includes("concrete");
  if (isTile) {
    // 2x2 tile grid with grout lines (texture covers 2ft x 2ft world space).
    ctx.fillStyle = accent;
    for (let i = 0; i < 24; i++) {
      ctx.globalAlpha = 0.05;
      ctx.fillRect(Math.random() * 512, Math.random() * 512, 90, 90);
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = "rgba(60,55,50,0.35)";
    ctx.lineWidth = 3;
    for (const v of [0, 256, 512]) {
      ctx.beginPath(); ctx.moveTo(v, 0); ctx.lineTo(v, 512); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, v); ctx.lineTo(512, v); ctx.stroke();
    }
  } else {
    // Planks: 4 rows (texture covers ~2ft x 2ft world => ~6" plank widths).
    const rows = 4;
    const rowH = 512 / rows;
    for (let r = 0; r < rows; r++) {
      const t = ((r * 37) % 100) / 100;
      ctx.fillStyle = blend(base, accent, 0.25 + t * 0.5);
      ctx.fillRect(0, r * rowH, 512, rowH);
      ctx.globalAlpha = 0.08;
      ctx.fillStyle = "#41382d";
      for (let g = 0; g < 7; g++) {
        const y = r * rowH + ((g * 73 + r * 31) % rowH);
        ctx.fillRect(0, y, 512, 1.2);
      }
      ctx.globalAlpha = 1;
      ctx.strokeStyle = "rgba(45,40,34,0.5)";
      ctx.lineWidth = 2.5;
      const joint = ((r * 0.37 + 0.21) % 1) * 512;
      ctx.beginPath(); ctx.moveTo(joint, r * rowH); ctx.lineTo(joint, (r + 1) * rowH); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, r * rowH); ctx.lineTo(512, r * rowH); ctx.stroke();
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  tex.colorSpace = THREE.SRGBColorSpace;
  floorTexCache.set(finishId, tex);
  return tex;
}

function blend(hexA: string, hexB: string, t: number): string {
  const a = new THREE.Color(hexA);
  const b = new THREE.Color(hexB);
  a.lerp(b, t);
  return `#${a.getHexString()}`;
}

// ---------------------------------------------------------------------------

interface Opening {
  at: number; // center along wall, meters from wall start
  width: number;
  y0: number;
  y1: number;
}

/** Match wall-mounted door/window items to their nearest wall. */
function openingsByWall(items: PlacedItem[], walls: WallSeg[], wallThickness: number): Map<number, Opening[]> {
  const map = new Map<number, Opening[]>();
  for (const it of items) {
    const def = getItemDef(it.defId);
    if (!def || def.category !== "doors-windows") continue;
    let best: { wall: WallSeg; dist: number; t: number } | null = null;
    for (const w of walls) {
      const apx = it.x - w.a.x;
      const apz = it.z - w.a.z;
      const t = (apx * w.dir.x + apz * w.dir.z) / w.length;
      if (t < -0.05 || t > 1.05) continue;
      const cx = w.a.x + w.dir.x * w.length * t;
      const cz = w.a.z + w.dir.z * w.length * t;
      const d = Math.hypot(it.x - cx, it.z - cz);
      if (!best || d < best.dist) best = { wall: w, dist: d, t };
    }
    if (!best || best.dist > wallThickness * 2 + 0.08) continue;
    const w = it.w ?? def.w;
    const h = it.h ?? def.h;
    const y0 = it.y ?? def.elevation ?? 0;
    const list = map.get(best.wall.index) ?? [];
    list.push({ at: best.t * best.wall.length, width: w + 0.01, y0: Math.max(0, y0 - 0.005), y1: y0 + h + 0.005 });
    map.set(best.wall.index, list);
  }
  return map;
}

/** Slice one wall (length L x height H) around its openings into rectangles. */
function wallSlices(L: number, H: number, openings: Opening[]): Array<{ x: number; y: number; w: number; h: number }> {
  const slices: Array<{ x: number; y: number; w: number; h: number }> = [];
  const sorted = [...openings]
    .map((o) => ({ ...o, start: Math.max(0, o.at - o.width / 2), end: Math.min(L, o.at + o.width / 2) }))
    .filter((o) => o.end > o.start && o.y1 > o.y0)
    .sort((a, b) => a.start - b.start);

  let cursor = 0;
  for (const o of sorted) {
    if (o.start > cursor + 0.001) slices.push({ x: cursor, y: 0, w: o.start - cursor, h: H });
    const left = Math.max(cursor, o.start);
    const width = o.end - left;
    if (width > 0.001) {
      if (o.y0 > 0.001) slices.push({ x: left, y: 0, w: width, h: o.y0 });
      if (o.y1 < H - 0.001) slices.push({ x: left, y: o.y1, w: width, h: H - o.y1 });
    }
    cursor = Math.max(cursor, o.end);
  }
  if (cursor < L - 0.001) slices.push({ x: cursor, y: 0, w: L - cursor, h: H });
  return slices;
}

export function Room({ doc }: { doc: DesignDoc }) {
  const view = useStudio((s) => s.view);
  const activeSurface = useStudio((s) => s.activeSurface);
  const setActiveSurface = useStudio((s) => s.setActiveSurface);

  const walls = useMemo(() => wallSegments(doc.room.points), [doc.room.points]);
  const inwardZ = useMemo(() => inwardLocalZ(doc.room.points), [doc.room.points]);
  const openings = useMemo(
    () => openingsByWall(doc.items, walls, doc.room.wallThickness),
    [doc.items, walls, doc.room.wallThickness],
  );

  const floorShape = useMemo(() => {
    const shape = new THREE.Shape();
    doc.room.points.forEach((p, i) => {
      if (i === 0) shape.moveTo(p.x, p.z);
      else shape.lineTo(p.x, p.z);
    });
    shape.closePath();
    return shape;
  }, [doc.room.points]);

  const floorFinish = getFinish(doc.surfaces.floor, "floor-oak-natural");
  const floorTex = useMemo(() => {
    const tex = floorTexture(floorFinish.id);
    if (tex) tex.repeat.set(1 / 0.6096, 1 / 0.6096);
    return tex;
  }, [floorFinish.id]);

  // Dollhouse wall hiding lives in DollhouseSync (StudioCanvas) so attached
  // doors/windows hide together with their wall.

  const paintFor = (wallIndex: number): string =>
    doc.surfaces.walls[String(wallIndex)] ?? doc.surfaces.walls.all ?? WALL_FALLBACK;

  const onWallClick = (e: ThreeEvent<MouseEvent>, wallIndex: number) => {
    if (e.delta > CLICK_SLOP_PX) return;
    const s = useStudio.getState();
    if (s.presentMode || s.placing) return; // placing: fall through to the capture plane
    e.stopPropagation();
    setActiveSurface({ kind: "wall", wallIndex });
  };

  const onFloorClick = (e: ThreeEvent<MouseEvent>) => {
    if (e.delta > CLICK_SLOP_PX) return;
    const s = useStudio.getState();
    if (s.presentMode || s.placing) return;
    e.stopPropagation();
    setActiveSurface({ kind: "floor" });
  };

  const t = doc.room.wallThickness;
  const H = doc.room.height;

  return (
    <group>
      {/* Floor */}
      <mesh rotation={[Math.PI / 2, 0, 0]} receiveShadow onClick={onFloorClick}>
        <shapeGeometry args={[floorShape]} />
        <meshStandardMaterial
          color={floorTex ? "#ffffff" : floorFinish.hex}
          map={floorTex ?? undefined}
          roughness={floorFinish.roughness ?? 0.6}
          side={THREE.DoubleSide}
        />
      </mesh>
      {activeSurface?.kind === "floor" && (
        <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0.004, 0]} raycast={() => null}>
          <shapeGeometry args={[floorShape]} />
          <meshBasicMaterial color="#5b8dd6" transparent opacity={0.18} side={THREE.DoubleSide} depthWrite={false} />
        </mesh>
      )}

      {/* Walls */}
      <group>
        {walls.map((w) => {
          const finish = getFinish(paintFor(w.index), WALL_FALLBACK);
          const slices = wallSlices(w.length, H, openings.get(w.index) ?? []);
          const angle = Math.atan2(w.b.z - w.a.z, w.b.x - w.a.x);
          const isActive = activeSurface?.kind === "wall" && activeSurface.wallIndex === w.index;
          // Inner wall face sits exactly on the polygon edge; slab extends outward.
          const slabZ = -inwardZ * (t / 2);
          return (
            <group
              key={w.index}
              position={[w.a.x, 0, w.a.z]}
              rotation={[0, -angle, 0]}
              userData={{ wallIndex: w.index }}
            >
              {slices.map((s, i) => (
                <mesh
                  key={i}
                  position={[s.x + s.w / 2, s.y + s.h / 2, slabZ]}
                  castShadow
                  receiveShadow
                  onClick={(e) => onWallClick(e, w.index)}
                >
                  <boxGeometry args={[s.w, s.h, t]} />
                  <meshStandardMaterial
                    color={isActive ? blend(finish.hex, "#5b8dd6", 0.3) : finish.hex}
                    roughness={finish.roughness ?? 0.94}
                  />
                </mesh>
              ))}
              {/* baseboard on the interior face */}
              <mesh position={[w.length / 2, 0.057, inwardZ * 0.011]} receiveShadow raycast={() => null}>
                <boxGeometry args={[w.length, 0.114, 0.022]} />
                <meshStandardMaterial color="#eceae3" roughness={0.7} />
              </mesh>
            </group>
          );
        })}
      </group>

      {/* Ceiling - walk mode only so orbit/plan stay open */}
      {view === "walk" && (
        <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, H, 0]}>
          <shapeGeometry args={[floorShape]} />
          <meshStandardMaterial
            color={getFinish(doc.surfaces.ceiling, "paint-pure-white").hex}
            side={THREE.DoubleSide}
            roughness={0.95}
          />
        </mesh>
      )}
    </group>
  );
}
