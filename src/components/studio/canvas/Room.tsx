"use client";

// Room Studio - room shell: polygon floor, walls with door/window cutouts,
// per-wall paint, camera-facing wall auto-hide (dollhouse view).

import * as THREE from "three";
import { useEffect, useMemo } from "react";
import { type ThreeEvent } from "@react-three/fiber";
import type { DesignDoc, PlacedItem } from "@/lib/studio/doc";
import {
  wallSegments, inwardLocalZ, roomHeightAt, type WallSeg, type RoomShellInfo,
} from "@/lib/studio/geometry";
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

  const isGrass = finishId.includes("grass");
  const isTile =
    finishId.includes("tile") || finishId.includes("concrete") ||
    finishId.includes("paver") || finishId.includes("bluestone") || finishId.includes("brick");
  if (isGrass) {
    // Mottled lawn: layered soft blotches + short blade strokes.
    for (let i = 0; i < 260; i++) {
      ctx.globalAlpha = 0.1;
      ctx.fillStyle = i % 2 ? accent : blend(base, "#8FAE68", 0.5);
      const s = 8 + Math.random() * 26;
      ctx.fillRect(Math.random() * 512, Math.random() * 512, s, s);
    }
    ctx.globalAlpha = 0.16;
    ctx.strokeStyle = blend(accent, "#3E5230", 0.5);
    ctx.lineWidth = 1.2;
    for (let i = 0; i < 220; i++) {
      const x = Math.random() * 512;
      const y = Math.random() * 512;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + (Math.random() - 0.5) * 5, y - 4 - Math.random() * 6);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  } else if (isTile) {
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

/** Match wall-mounted door/window/niche items to their nearest wall. */
function openingsByWall(items: PlacedItem[], walls: WallSeg[], wallThickness: number): Map<number, Opening[]> {
  const map = new Map<number, Opening[]>();
  for (const it of items) {
    const def = getItemDef(it.defId);
    if (!def || (def.category !== "doors-windows" && !def.cutsWall)) continue;
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

/**
 * Build one wall as a 2D outline (wall-local: x along the wall, y up) with
 * its openings as holes, extruded to the wall thickness. The top edge can be
 * sloped (shed ceilings), which boxes-per-slice couldn't represent.
 */
function buildWallGeometry(
  L: number,
  hStart: number,
  hEnd: number,
  openings: Opening[],
  thickness: number,
): THREE.ExtrudeGeometry {
  const outline = new THREE.Shape();
  outline.moveTo(0, 0);
  outline.lineTo(L, 0);
  outline.lineTo(L, hEnd);
  outline.lineTo(0, hStart);
  outline.closePath();

  const heightAt = (x: number) => hStart + (hEnd - hStart) * (x / L);
  for (const o of openings) {
    const start = Math.max(0.01, o.at - o.width / 2);
    const end = Math.min(L - 0.01, o.at + o.width / 2);
    if (end - start < 0.02) continue;
    // keep the hole inside the (possibly sloped) outline
    const maxTop = Math.min(heightAt(start), heightAt(end)) - 0.04;
    const y0 = Math.max(0, o.y0);
    const y1 = Math.min(o.y1, maxTop);
    if (y1 - y0 < 0.02) continue;
    const hole = new THREE.Path();
    hole.moveTo(start, y0);
    hole.lineTo(end, y0);
    hole.lineTo(end, y1);
    hole.lineTo(start, y1);
    hole.closePath();
    outline.holes.push(hole);
  }

  const geo = new THREE.ExtrudeGeometry(outline, { depth: thickness, bevelEnabled: false });
  return geo;
}

export function Room({ doc }: { doc: DesignDoc }) {
  const view = useStudio((s) => s.view);
  const activeSurface = useStudio((s) => s.activeSurface);
  const setActiveSurface = useStudio((s) => s.setActiveSurface);

  const walls = useMemo(() => wallSegments(doc.room.points), [doc.room.points]);
  const inwardZ = useMemo(() => inwardLocalZ(doc.room.points), [doc.room.points]);
  const shell: RoomShellInfo = useMemo(
    () => ({ points: doc.room.points, height: doc.room.height, slope: doc.room.slope }),
    [doc.room.points, doc.room.height, doc.room.slope],
  );
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
  const outdoor = !!doc.room.outdoor;

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
          const hStart = roomHeightAt(shell, w.a);
          const hEnd = roomHeightAt(shell, w.b);
          const angle = Math.atan2(w.b.z - w.a.z, w.b.x - w.a.x);
          const isActive = activeSurface?.kind === "wall" && activeSurface.wallIndex === w.index;
          const level = Math.abs(hStart - hEnd) < 0.005;
          return (
            <group
              key={w.index}
              position={[w.a.x, 0, w.a.z]}
              rotation={[0, -angle, 0]}
              userData={{ wallIndex: w.index }}
            >
              <WallMesh
                length={w.length}
                hStart={hStart}
                hEnd={hEnd}
                openings={openings.get(w.index) ?? []}
                thickness={t}
                inwardZ={inwardZ}
                color={isActive ? blend(finish.hex, "#5b8dd6", 0.3) : finish.hex}
                roughness={finish.roughness ?? 0.94}
                onClick={(e) => onWallClick(e, w.index)}
              />
              {/* baseboard on the interior face (indoor rooms only) */}
              {!outdoor && (
                <mesh position={[w.length / 2, 0.057, inwardZ * 0.011]} receiveShadow raycast={() => null}>
                  <boxGeometry args={[w.length, 0.114, 0.022]} />
                  <meshStandardMaterial color="#eceae3" roughness={0.7} />
                </mesh>
              )}
              {/* crown molding - level walls only (sloped tops skip it) */}
              {doc.room.crown && level && !outdoor && (
                <mesh
                  position={[w.length / 2, hStart - 0.045, inwardZ * 0.019]}
                  rotation={[inwardZ * Math.PI / 4, 0, 0]}
                  receiveShadow
                  raycast={() => null}
                >
                  <boxGeometry args={[w.length, 0.095, 0.012]} />
                  <meshStandardMaterial color="#f2f0ea" roughness={0.65} />
                </mesh>
              )}
            </group>
          );
        })}
      </group>

      {/* Ceiling - walk mode only so orbit/plan stay open; outdoor spaces have open sky */}
      {view === "walk" && !outdoor && (
        <CeilingMesh
          shell={shell}
          color={getFinish(doc.surfaces.ceiling, "paint-pure-white").hex}
        />
      )}
    </group>
  );
}

function WallMesh({
  length, hStart, hEnd, openings, thickness, inwardZ, color, roughness, onClick,
}: {
  length: number;
  hStart: number;
  hEnd: number;
  openings: Opening[];
  thickness: number;
  inwardZ: 1 | -1;
  color: string;
  roughness: number;
  onClick: (e: ThreeEvent<MouseEvent>) => void;
}) {
  const geometry = useMemo(
    () => buildWallGeometry(length, hStart, hEnd, openings, thickness),
    [length, hStart, hEnd, openings, thickness],
  );
  // free the previous geometry when a rebuild replaces it
  useEffect(() => () => geometry.dispose(), [geometry]);
  // Extrusion grows along +Z from the shape plane; shift so the INNER face
  // lands exactly on the polygon edge and the slab body extends outward.
  const zOffset = inwardZ === 1 ? -thickness : 0;
  return (
    <mesh
      geometry={geometry}
      position={[0, 0, zOffset]}
      castShadow
      receiveShadow
      onClick={onClick}
    >
      <meshStandardMaterial color={color} roughness={roughness} />
    </mesh>
  );
}

/** Flat or tilted ceiling plane built from the room polygon with per-corner heights. */
function CeilingMesh({ shell, color }: { shell: RoomShellInfo; color: string }) {
  const geometry = useMemo(() => {
    const pts = shell.points;
    const positions: number[] = [];
    const indices: number[] = [];
    for (const p of pts) positions.push(p.x, roomHeightAt(shell, p), p.z);
    for (let i = 1; i < pts.length - 1; i++) indices.push(0, i, i + 1);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  }, [shell]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <mesh geometry={geometry}>
      <meshStandardMaterial color={color} side={THREE.DoubleSide} roughness={0.95} />
    </mesh>
  );
}
