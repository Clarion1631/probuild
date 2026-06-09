// Room Studio - LiDAR scan import.
//
// Converts a captured room scan into a v2 DesignDoc. Two input shapes are
// accepted:
//
// 1. "simple" - what the ProBuild mobile app sends after a RoomPlan capture:
//    { corners: [{x,z}...], height, openings: [{kind, wallIndex|position, width, height, sillHeight}] }
//    Corners are meters, ordered around the room perimeter.
//
// 2. Apple RoomPlan CapturedRoom JSON (the .json export of RoomCaptureSession):
//    { walls: [{ transform: number[16], dimensions: [w,h,d] }], doors: [...],
//      windows: [...], openings: [...] }
//    Each surface has a 4x4 column-major transform and [width,height,depth]
//    dimensions; wall endpoints are the transform applied to (+-w/2, 0, 0).
//
// Both convert into: polygon room + door/window items snapped to the walls.

import type { DesignDoc, Pt } from "./doc";
import { newItemId } from "./doc";
import { DEFAULT_SURFACES } from "./materials";
import { wallSegments, nearestWall, wallFacingRotation, polygonBounds, signedArea } from "./geometry";
import { feet, inches } from "./units";

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

export interface SimpleScanOpening {
  kind: "door" | "window" | "opening";
  /** Center of the opening in plan space, meters. */
  x: number;
  z: number;
  width: number;
  height: number;
  /** Bottom of the opening above the floor (windows). */
  sillHeight?: number;
}

export interface SimpleScan {
  corners: Array<{ x: number; z: number }>;
  height?: number;
  openings?: SimpleScanOpening[];
}

interface RoomPlanSurface {
  transform?: number[];
  dimensions?: number[];
  category?: string | Record<string, unknown>;
}

export interface RoomPlanCapture {
  walls?: RoomPlanSurface[];
  doors?: RoomPlanSurface[];
  windows?: RoomPlanSurface[];
  openings?: RoomPlanSurface[];
  floors?: RoomPlanSurface[];
}

const MIN_ROOM = feet(3);
const MAX_ROOM = feet(80);

// ---------------------------------------------------------------------------

export function scanToDoc(payload: unknown): DesignDoc {
  const p = payload as Partial<SimpleScan> & Partial<RoomPlanCapture>;
  if (Array.isArray(p.corners) && p.corners.length >= 3) {
    return simpleScanToDoc(p as SimpleScan);
  }
  if (Array.isArray(p.walls) && p.walls.length >= 3) {
    return roomPlanToDoc(p as RoomPlanCapture);
  }
  throw new ScanImportError("Scan payload needs either `corners` (3+) or RoomPlan `walls` (3+)");
}

export class ScanImportError extends Error {}

// ---------------------------------------------------------------------------
// Simple shape
// ---------------------------------------------------------------------------

function simpleScanToDoc(scan: SimpleScan): DesignDoc {
  const { points, offset } = sanitizePolygon(scan.corners.map((c) => ({ x: num(c.x), z: num(c.z) })));
  const height = clamp(num(scan.height, feet(9)), feet(6.5), feet(20));

  const doc: DesignDoc = {
    version: 2,
    room: { points, height, wallThickness: inches(5) },
    surfaces: {
      floor: DEFAULT_SURFACES.floor,
      ceiling: DEFAULT_SURFACES.ceiling,
      walls: { all: DEFAULT_SURFACES.wall },
    },
    items: [],
  };

  const walls = wallSegments(points);
  for (const o of scan.openings ?? []) {
    // openings arrive in the scan's coordinate frame - apply the same
    // centering offset the polygon received
    const hit = nearestWall({ x: num(o.x) - offset.x, z: num(o.z) - offset.z }, walls);
    if (!hit || hit.distance > 0.6) continue;
    const width = clamp(num(o.width, inches(32)), inches(12), inches(192));
    const height_ = clamp(num(o.height, o.kind === "door" ? inches(80) : inches(48)), inches(12), feet(12));
    const defId = o.kind === "door" ? "door-single" : o.kind === "opening" ? "doorway-open" : "window-single";
    doc.items.push({
      id: newItemId(),
      defId,
      x: hit.point.x,
      z: hit.point.z,
      y: o.kind === "window" ? clamp(num(o.sillHeight, inches(30)), 0, feet(8)) : undefined,
      rotation: wallFacingRotation(hit.wall),
      w: width,
      h: height_,
    });
  }
  return doc;
}

// ---------------------------------------------------------------------------
// Apple RoomPlan CapturedRoom
// ---------------------------------------------------------------------------

interface WallLine {
  a: Pt;
  b: Pt;
  height: number;
}

function roomPlanToDoc(capture: RoomPlanCapture): DesignDoc {
  const wallLines: WallLine[] = [];
  for (const w of capture.walls ?? []) {
    const line = surfaceToLine(w);
    if (line) wallLines.push(line);
  }
  if (wallLines.length < 3) throw new ScanImportError("RoomPlan capture has fewer than 3 usable walls");

  const { points, offset } = sanitizePolygon(chainWalls(wallLines));
  const height = clamp(
    wallLines.reduce((m, w) => Math.max(m, w.height), 0) || feet(9),
    feet(6.5),
    feet(20),
  );

  const doc: DesignDoc = {
    version: 2,
    room: { points, height, wallThickness: inches(5) },
    surfaces: {
      floor: DEFAULT_SURFACES.floor,
      ceiling: DEFAULT_SURFACES.ceiling,
      walls: { all: DEFAULT_SURFACES.wall },
    },
    items: [],
  };

  const walls = wallSegments(points);
  const place = (s: RoomPlanSurface, defId: string, defaultH: number, sill?: number) => {
    const line = surfaceToLine(s);
    if (!line) return;
    const cx = (line.a.x + line.b.x) / 2 - offset.x;
    const cz = (line.a.z + line.b.z) / 2 - offset.z;
    const hit = nearestWall({ x: cx, z: cz }, walls);
    if (!hit || hit.distance > 0.6) return;
    const width = clamp(Math.hypot(line.b.x - line.a.x, line.b.z - line.a.z) || inches(32), inches(12), inches(192));
    doc.items.push({
      id: newItemId(),
      defId,
      x: hit.point.x,
      z: hit.point.z,
      y: sill,
      rotation: wallFacingRotation(hit.wall),
      w: width,
      h: clamp(line.height || defaultH, inches(12), feet(12)),
    });
  };

  for (const d of capture.doors ?? []) place(d, "door-single", inches(80));
  for (const w of capture.windows ?? []) place(w, "window-single", inches(48), inches(30));
  for (const o of capture.openings ?? []) place(o, "doorway-open", inches(80));

  return doc;
}

/** Wall surface -> its endpoints on the floor plane via the 4x4 transform. */
function surfaceToLine(s: RoomPlanSurface): WallLine | null {
  const t = s.transform;
  const d = s.dimensions;
  if (!Array.isArray(t) || t.length !== 16 || !Array.isArray(d) || d.length < 2) return null;
  const w = num(d[0]);
  const h = num(d[1], feet(9));
  if (!(w > 0.05)) return null;
  // Column-major simd_float4x4: basis X = (t[0], t[1], t[2]), origin = (t[12], t[13], t[14]).
  // RoomPlan's plan axes are X/Z (Y up) - project to the floor plane.
  const ox = num(t[12]);
  const oz = num(t[14]);
  const bx = num(t[0]);
  const bz = num(t[2]);
  const len = Math.hypot(bx, bz) || 1;
  const ux = bx / len;
  const uz = bz / len;
  return {
    a: { x: ox - (ux * w) / 2, z: oz - (uz * w) / 2 },
    b: { x: ox + (ux * w) / 2, z: oz + (uz * w) / 2 },
    height: h,
  };
}

/**
 * Order scanned wall segments into a closed polygon: greedily chain each
 * wall's far endpoint to the nearest endpoint of an unused wall. RoomPlan
 * walls arrive unordered and with small gaps at corners; endpoints within
 * 30 cm snap together.
 */
function chainWalls(lines: WallLine[]): Pt[] {
  const used = new Array(lines.length).fill(false);
  const pts: Pt[] = [];
  let cur = lines[0];
  used[0] = true;
  pts.push(cur.a);
  let tail = cur.b;

  for (let step = 1; step < lines.length; step++) {
    let bestIdx = -1;
    let bestDist = Infinity;
    let bestFlip = false;
    for (let i = 0; i < lines.length; i++) {
      if (used[i]) continue;
      const dA = Math.hypot(lines[i].a.x - tail.x, lines[i].a.z - tail.z);
      const dB = Math.hypot(lines[i].b.x - tail.x, lines[i].b.z - tail.z);
      if (dA < bestDist) { bestDist = dA; bestIdx = i; bestFlip = false; }
      if (dB < bestDist) { bestDist = dB; bestIdx = i; bestFlip = true; }
    }
    if (bestIdx === -1 || bestDist > 0.5) break;
    used[bestIdx] = true;
    const w = lines[bestIdx];
    const from = bestFlip ? w.b : w.a;
    const to = bestFlip ? w.a : w.b;
    // corner = average of the two endpoints that should coincide
    pts.push({ x: (tail.x + from.x) / 2, z: (tail.z + from.z) / 2 });
    tail = to;
  }
  pts.push(tail);
  return pts;
}

// ---------------------------------------------------------------------------

function sanitizePolygon(raw: Pt[]): { points: Pt[]; offset: Pt } {
  let pts = raw.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.z));
  // drop consecutive duplicates (within 5 cm)
  pts = pts.filter((p, i) => {
    const prev = pts[(i - 1 + pts.length) % pts.length];
    return i === 0 || Math.hypot(p.x - prev.x, p.z - prev.z) > 0.05;
  });
  // drop a closing point that duplicates the first
  if (pts.length > 3) {
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (Math.hypot(first.x - last.x, first.z - last.z) < 0.15) pts = pts.slice(0, -1);
  }
  if (pts.length < 3) throw new ScanImportError("Scan polygon needs at least 3 distinct corners");

  // center on origin (the studio camera + grid assume a roughly centered room)
  const bounds = polygonBounds(pts);
  if (bounds.width < MIN_ROOM || bounds.length < MIN_ROOM) {
    throw new ScanImportError("Scanned room is too small (under 3 ft on a side)");
  }
  if (bounds.width > MAX_ROOM || bounds.length > MAX_ROOM) {
    throw new ScanImportError("Scanned room is too large (over 80 ft on a side)");
  }
  const offset = { x: bounds.center.x, z: bounds.center.z };
  pts = pts.map((p) => ({ x: p.x - offset.x, z: p.z - offset.z }));

  // near-degenerate polygon guard
  if (Math.abs(signedArea(pts)) < 0.5) {
    throw new ScanImportError("Scan corners don't form a usable room outline");
  }
  return { points: pts, offset };
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
