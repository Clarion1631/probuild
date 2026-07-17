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

export interface RoomShellInfo {
  points: Pt[];
  height: number;
  slope?: { lowWallIndex: number; lowHeight: number };
}

/**
 * Straighten a nearly-rectilinear polygon: every wall within `toleranceDeg`
 * of horizontal/vertical becomes exactly axis-aligned by walking the loop and
 * carrying the corrected corners forward. Returns null when the result would
 * not close cleanly or degenerates (caller should keep the original).
 */
export function squareUpPolygon(points: Pt[], toleranceDeg = 20): Pt[] | null {
  const tol = (toleranceDeg * Math.PI) / 180;
  const n = points.length;
  const out: Pt[] = [{ ...points[0] }];

  for (let i = 0; i < n - 1; i++) {
    const cur = out[i];
    const target = points[i + 1];
    const dx = target.x - points[i].x;
    const dz = target.z - points[i].z;
    const len = Math.hypot(dx, dz);
    const angle = Math.atan2(dz, dx);
    // distance to the nearest axis direction (0, 90, 180, 270)
    const snapped = Math.round(angle / (Math.PI / 2)) * (Math.PI / 2);
    if (Math.abs(angDelta(angle, snapped)) <= tol) {
      out.push({
        x: cur.x + Math.cos(snapped) * len,
        z: cur.z + Math.sin(snapped) * len,
      });
    } else {
      // leave deliberately-angled walls alone: carry the original offset
      out.push({ x: cur.x + dx, z: cur.z + dz });
    }
  }

  // The loop must close: the last wall runs from out[n-1] back to out[0].
  // If that closing wall is near-axis, force the final corner onto the axis
  // of the first point; otherwise accept the drift if it's small.
  const last = out[n - 1];
  const first = out[0];
  const cdx = first.x - last.x;
  const cdz = first.z - last.z;
  const cAngle = Math.atan2(cdz, cdx);
  const cSnapped = Math.round(cAngle / (Math.PI / 2)) * (Math.PI / 2);
  if (Math.abs(angDelta(cAngle, cSnapped)) <= tol) {
    // axis-align the closing wall by projecting the last corner
    if (Math.abs(Math.cos(cSnapped)) > 0.5) last.z = first.z; // closing wall is horizontal
    else last.x = first.x; // closing wall is vertical
  }

  if (Math.abs(signedArea(out)) < 0.5) return null;
  for (let i = 0; i < n; i++) {
    const a = out[i];
    const b = out[(i + 1) % n];
    if (Math.hypot(b.x - a.x, b.z - a.z) < 0.2) return null;
  }
  return out;
}

function angDelta(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * Remove one corner from a room polygon. Returns the new points, or null if
 * the result would degenerate (fewer than 3 corners, collapsed area, or a
 * too-short wall).
 */
export function removeCornerFromPolygon(points: Pt[], index: number): Pt[] | null {
  if (points.length <= 3) return null;
  const next = points.filter((_, i) => i !== index);
  if (Math.abs(signedArea(next)) < 0.75) return null;
  for (let i = 0; i < next.length; i++) {
    const a = next[i];
    const b = next[(i + 1) % next.length];
    if (Math.hypot(b.x - a.x, b.z - a.z) < 0.3048) return null;
  }
  return next;
}

/**
 * Ceiling height at a plan point. Flat rooms return `height`. A slanted
 * (shed) ceiling interpolates from `slope.lowHeight` at the low wall to
 * `height` at the opposite side - only meaningful for 4-corner rect rooms,
 * which is enforced by the UI.
 */
export function roomHeightAt(room: RoomShellInfo, p: Pt): number {
  const s = room.slope;
  if (!s || room.points.length !== 4) return room.height;
  const walls = wallSegments(room.points);
  const low = walls[s.lowWallIndex];
  if (!low) return room.height;
  // distance from the low wall plane along its inward normal
  const d = (p.x - low.a.x) * low.normal.x + (p.z - low.a.z) * low.normal.z;
  // room depth along that axis = distance of the farthest corner
  let span = 0;
  for (const c of room.points) {
    const dc = (c.x - low.a.x) * low.normal.x + (c.z - low.a.z) * low.normal.z;
    span = Math.max(span, dc);
  }
  if (span < 1e-6) return room.height;
  const t = Math.min(1, Math.max(0, d / span));
  return s.lowHeight + (room.height - s.lowHeight) * t;
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
