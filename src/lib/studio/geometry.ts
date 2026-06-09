// Room Studio - 2D floor-plan geometry helpers. Pure math, no three.js.

import type { Pt } from "./doc";

export interface WallSeg {
  index: number;
  a: Pt;
  b: Pt;
  /** Unit vector a→b. */
  dir: Pt;
  /** Inward-facing normal (toward room interior). */
  normal: Pt;
  length: number;
}

/** Signed area: > 0 for counter-clockwise polygons (screen-plan with +z down = clockwise visual). */
export function signedArea(points: Pt[]): number {
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    s += p.x * q.z - q.x * p.z;
  }
  return s / 2;
}

/** Build wall segments with inward normals regardless of winding. */
export function wallSegments(points: Pt[]): WallSeg[] {
  const positive = signedArea(points) > 0;
  return points.map((a, i) => {
    const b = points[(i + 1) % points.length];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    const dir = { x: dx / len, z: dz / len };
    // With +x right and +z toward the viewer (plan view), a positive signed
    // area means the interior lies to the LEFT of each directed edge, i.e.
    // along (-dir.z, dir.x). Verified against makeRectRoom's point order.
    const n = positive ? { x: -dir.z, z: dir.x } : { x: dir.z, z: -dir.x };
    return { index: i, a, b, dir, normal: n, length: len };
  });
}

/** +1 if the inward normal maps to local +Z in a wall-local frame built by rotating dir onto +X; else -1. */
export function inwardLocalZ(points: Pt[]): 1 | -1 {
  return signedArea(points) > 0 ? 1 : -1;
}

export function pointInPolygon(p: Pt, points: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i];
    const b = points[j];
    const intersects = a.z > p.z !== b.z > p.z &&
      p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function polygonBounds(points: Pt[]): { min: Pt; max: Pt; center: Pt; width: number; length: number } {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
  }
  return {
    min: { x: minX, z: minZ },
    max: { x: maxX, z: maxZ },
    center: { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 },
    width: maxX - minX,
    length: maxZ - minZ,
  };
}

export interface WallHit {
  wall: WallSeg;
  /** Distance from p to the wall line. */
  distance: number;
  /** Parameter along the wall [0..1]. */
  t: number;
  /** Closest point on the wall segment. */
  point: Pt;
}

/** Closest wall to a point (within segment bounds). */
export function nearestWall(p: Pt, walls: WallSeg[]): WallHit | null {
  let best: WallHit | null = null;
  for (const w of walls) {
    const apx = p.x - w.a.x;
    const apz = p.z - w.a.z;
    const t = Math.max(0, Math.min(1, (apx * w.dir.x + apz * w.dir.z) / w.length));
    const cx = w.a.x + w.dir.x * w.length * t;
    const cz = w.a.z + w.dir.z * w.length * t;
    const d = Math.hypot(p.x - cx, p.z - cz);
    if (!best || d < best.distance) {
      best = { wall: w, distance: d, t, point: { x: cx, z: cz } };
    }
  }
  return best;
}

/** Angle (radians) for an item whose BACK faces the given wall (front faces inward). */
export function wallFacingRotation(w: WallSeg): number {
  // Item front faces +Z in local space; rotate so local +Z aligns with the inward normal.
  return Math.atan2(w.normal.x, w.normal.z);
}

export interface OBB {
  cx: number;
  cz: number;
  hw: number; // half width  (local X)
  hd: number; // half depth  (local Z)
  rot: number;
}

/** Oriented-box overlap via separating-axis test (2D). */
export function obbOverlap(a: OBB, b: OBB): boolean {
  const axes: Pt[] = [];
  for (const o of [a, b]) {
    axes.push({ x: Math.cos(o.rot), z: Math.sin(o.rot) });
    axes.push({ x: -Math.sin(o.rot), z: Math.cos(o.rot) });
  }
  for (const axis of axes) {
    const [minA, maxA] = projectOBB(a, axis);
    const [minB, maxB] = projectOBB(b, axis);
    if (maxA < minB || maxB < minA) return false;
  }
  return true;
}

function projectOBB(o: OBB, axis: Pt): [number, number] {
  const cos = Math.cos(o.rot);
  const sin = Math.sin(o.rot);
  const corners = [
    { x: o.hw, z: o.hd }, { x: -o.hw, z: o.hd }, { x: o.hw, z: -o.hd }, { x: -o.hw, z: -o.hd },
  ];
  let min = Infinity, max = -Infinity;
  for (const c of corners) {
    const wx = o.cx + c.x * cos - c.z * sin;
    const wz = o.cz + c.x * sin + c.z * cos;
    const p = wx * axis.x + wz * axis.z;
    min = Math.min(min, p);
    max = Math.max(max, p);
  }
  return [min, max];
}

/**
 * Edge-magnet: when dragging box `moving`, if one of its side edges comes
 * within `threshold` of a stationary box edge at a compatible angle, return
 * the snapped center position. Cheap O(n) pass, only called during drag.
 */
export function snapToNeighbors(
  moving: OBB,
  others: OBB[],
  threshold: number,
): { cx: number; cz: number } | null {
  const angle = normAngle(moving.rot);
  for (const o of others) {
    if (Math.abs(angDiff(angle, normAngle(o.rot))) > 0.05) continue; // only parallel items snap
    // Work in the other box's local frame.
    const cos = Math.cos(-o.rot);
    const sin = Math.sin(-o.rot);
    const dx = moving.cx - o.cx;
    const dz = moving.cz - o.cz;
    const lx = dx * cos - dz * sin;
    const lz = dx * sin + dz * cos;
    // Snap side-by-side along local X (cabinet runs).
    const gapX = Math.abs(lx) - (moving.hw + o.hw);
    if (Math.abs(gapX) < threshold && Math.abs(lz) < Math.max(moving.hd, o.hd)) {
      const snappedLx = Math.sign(lx) * (moving.hw + o.hw);
      // Also align depth (back edges flush) if close.
      const backAlign = Math.abs(lz - (o.hd - moving.hd)) < threshold ? o.hd - moving.hd : lz;
      const wcos = Math.cos(o.rot);
      const wsin = Math.sin(o.rot);
      return {
        cx: o.cx + snappedLx * wcos - backAlign * wsin,
        cz: o.cz + snappedLx * wsin + backAlign * wcos,
      };
    }
  }
  return null;
}

function normAngle(a: number): number {
  const t = a % (Math.PI * 2);
  return t < 0 ? t + Math.PI * 2 : t;
}

function angDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  // Treat 180° flips as parallel.
  if (d > Math.PI / 2) d -= Math.PI;
  if (d < -Math.PI / 2) d += Math.PI;
  return d;
}
