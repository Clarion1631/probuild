// Room Studio - shared wall math. Pure (no React, no three.js).
//
// A straight wall from a to b (meters, x/z plane) is a catalog item whose
// center is the midpoint, `w` is the length, and rotation (three.js Y) is
// atan2(-(b.z - a.z), b.x - a.x). The item's local +X maps to (cos r, -sin r).

import type { Pt, PlacedItem } from "./doc";
import { getItemDef } from "./catalog";
import { nearestWall, wallFacingRotation, type WallHit, type WallSeg } from "./geometry";
import { inches } from "./units";

export interface WallPose {
  x: number;
  z: number;
  rotation: number;
  w: number;
}

/** Catalog ids that are straight, freestanding wall items. */
export const WALL_DEF_IDS = ["interior-wall", "interior-wall-doorway", "pony-wall"] as const;

export function isWallDef(defId: string): boolean {
  return (WALL_DEF_IDS as readonly string[]).includes(defId);
}

// A number of inches: 54, 54.5, .5, 1/2, or 54 1/2.
const INCH_NUM = String.raw`(?:\d+(?:\.\d+)?\s+\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?|\.\d+)`;
const FT_NUM = String.raw`(\d+(?:\.\d+)?|\.\d+)`;
const UNIT_IN = String.raw`(?:"|in|inch|inches)`;
const FT_IN = new RegExp(String.raw`^${FT_NUM}\s*(?:'|ft|feet|foot)\s*(?:(?:-\s*)?(${INCH_NUM})\s*${UNIT_IN}?)?$`);
const IN_ONLY = new RegExp(String.raw`^(${INCH_NUM})\s*${UNIT_IN}?$`);

function inchNumber(t: string): number {
  const parts = t.trim().split(/\s+/);
  let total = 0;
  for (const part of parts) {
    if (part.includes("/")) {
      const [n, d] = part.split("/");
      total += parseFloat(n) / parseFloat(d);
    } else {
      total += parseFloat(part);
    }
  }
  return total;
}

/**
 * Parse a typed length into meters. Accepts `54`, `54"`, `54 in`, `4'6"`,
 * `4' 6`, `4'6`, `4.5'`, `4 ft 6 in`, `10'`, fractions (`54 1/2`, `1/2`,
 * `4'6 1/2"`) and carpenter dashes (`4'-6"`, `4' - 6"`). Bare numbers are inches.
 * Returns null for empty, negative, zero, or unparseable input.
 */
export function parseLength(text: string): number | null {
  const s = text
    .trim()
    .toLowerCase()
    .replace(/[“”″]/g, '"')
    .replace(/[‘’′]/g, "'")
    .replace(/\s+/g, " ");
  if (!s) return null;
  let totalIn: number;
  let m = s.match(FT_IN);
  if (m) {
    totalIn = parseFloat(m[1]) * 12 + (m[2] ? inchNumber(m[2]) : 0);
  } else {
    m = s.match(IN_ONLY);
    if (!m) return null;
    totalIn = inchNumber(m[1]);
  }
  if (!Number.isFinite(totalIn) || totalIn <= 0) return null;
  return inches(totalIn);
}

/** Allowed straight-wall length range (matches the catalog resizable bounds). */
export const WALL_MIN = inches(4);
export const WALL_MAX = inches(288);
const LEN_TOL = 1e-6;

/** One shared bound check for drawn, typed and stored wall lengths. */
export function wallLengthProblem(len: number): "short" | "long" | null {
  if (len < WALL_MIN - LEN_TOL) return "short";
  if (len > WALL_MAX + LEN_TOL) return "long";
  return null;
}

/** Wall from a to b -> the item pose that renders it. */
export function wallItemPose(a: Pt, b: Pt): WallPose {
  return {
    x: (a.x + b.x) / 2,
    z: (a.z + b.z) / 2,
    rotation: Math.atan2(-(b.z - a.z), b.x - a.x),
    w: Math.hypot(b.x - a.x, b.z - a.z),
  };
}

/** Inverse of wallItemPose. Takes the item's resolved length `w`. */
export function wallEndpoints(item: { x: number; z: number; rotation: number }, w: number): { a: Pt; b: Pt } {
  const dx = Math.cos(item.rotation) * (w / 2);
  const dz = -Math.sin(item.rotation) * (w / 2);
  return {
    a: { x: item.x - dx, z: item.z - dz },
    b: { x: item.x + dx, z: item.z + dz },
  };
}

export interface DrawSnapCtx {
  /** Room corners + interior wall endpoints. */
  anchors: Pt[];
  /** Snap direction to the nearest 45 degrees (off while Shift is held). */
  angleSnap: boolean;
}

export const ENDPOINT_SNAP = inches(4);
const GRID_IN = inches(1);
const LEN_STEP = inches(0.5);

/**
 * Snap a raw cursor point while drawing. Order: nearby anchor (within 4"),
 * else (with a start point and angle snap on) nearest 45 degrees with the
 * length rounded to 1/2", else the 1" grid.
 */
export function snapDrawPoint(raw: Pt, from: Pt | null, ctx: DrawSnapCtx): Pt {
  let best: Pt | null = null;
  let bestD = ENDPOINT_SNAP;
  for (const a of ctx.anchors) {
    const d = Math.hypot(a.x - raw.x, a.z - raw.z);
    if (d <= bestD) {
      bestD = d;
      best = a;
    }
  }
  if (best) return { x: best.x, z: best.z };

  if (from && ctx.angleSnap) {
    const dx = raw.x - from.x;
    const dz = raw.z - from.z;
    const len = Math.hypot(dx, dz);
    if (len > 0) {
      const step = Math.PI / 4;
      const ang = Math.round(Math.atan2(dz, dx) / step) * step;
      const snappedLen = Math.round(len / LEN_STEP) * LEN_STEP;
      return { x: from.x + Math.cos(ang) * snappedLen, z: from.z + Math.sin(ang) * snappedLen };
    }
  }

  return { x: Math.round(raw.x / GRID_IN) * GRID_IN, z: Math.round(raw.z / GRID_IN) * GRID_IN };
}

/** Anchors for snapDrawPoint: room corners plus both ends of every straight wall item. */
export function drawAnchors(roomPoints: Pt[], items: PlacedItem[], widthOf: (it: PlacedItem) => number): Pt[] {
  const out: Pt[] = roomPoints.map((p) => ({ x: p.x, z: p.z }));
  for (const it of items) {
    if (!isWallDef(it.defId)) continue;
    const { a, b } = wallEndpoints(it, widthOf(it));
    out.push(a, b);
  }
  return out;
}

export type LengthKeyAction = "none" | "submit" | "cancel";

/**
 * Apply one keystroke to the typed-length text. Lets the draw tool keep
 * collecting keys before the length input has focus (fast typing).
 */
export function lengthKeyEdit(text: string, key: string): { text: string; action: LengthKeyAction } {
  if (key === "Enter") return { text, action: "submit" };
  if (key === "Escape") return { text, action: "cancel" };
  if (key === "Backspace") return { text: text.slice(0, -1), action: "none" };
  if (key.length === 1 && /[0-9.'" ftin/-]/i.test(key)) return { text: text + key, action: "none" };
  return { text, action: "none" };
}

// ---------------------------------------------------------------------------
// Openings (doors/windows in freestanding walls) and wall-mount hosting
// ---------------------------------------------------------------------------

/** Wall items that can host doors/windows (the doorway variant has its own opening). */
export const OPENING_HOST_IDS = ["interior-wall", "pony-wall"] as const;

export function isOpeningHost(defId: string): boolean {
  return (OPENING_HOST_IDS as readonly string[]).includes(defId);
}

export interface WallOpening {
  /** Offset of the opening's center from the wall's midpoint along the wall (item local +X, toward end b), meters. */
  center: number;
  width: number;
  /** Height of the opening's bottom / top above the floor, meters. */
  bottom: number;
  top: number;
}

/** A door/window/opening within this much of the wall face counts as in the wall. */
const OPENING_FACE_SLOP = inches(1);
/** Max angle (radians) between a door's rotation and the wall's to count as parallel. */
const OPENING_PARALLEL_TOL = 0.05;
const MIN_OPENING = inches(0.5);

/**
 * Openings cut into a straight wall item by door/window items. A door counts
 * when its center is within (half the wall thickness + 1") of the wall SEGMENT
 * (the projection is clamped to the wall's own length, never the infinite
 * line, so short stubs that line up with a door get no phantom opening) and it
 * is parallel to the wall (either face). Openings are clipped to the wall.
 * Which wall hosts an item is decided by the SAME rule that snaps it
 * (nearestHostWall over the outline and every freestanding wall), so an item
 * hosted by the outline, or by a different wall, never cuts this one.
 * Pure function of committed doc state.
 */
export function openingsOnWall(wall: PlacedItem, items: PlacedItem[], outline: WallSeg[] = []): WallOpening[] {
  const wallItems = items.some((i) => i.id === wall.id) ? items : [...items, wall];
  const out: WallOpening[] = [];
  for (const it of items) {
    if (it.id === wall.id) continue;
    const found = interiorOpeningFor(it, wallItems, outline);
    if (found && found.wall.id === wall.id) out.push(found.opening);
  }
  return out.sort((a, b) => a.center - b.center);
}

export interface InteriorOpening {
  /** The freestanding wall item that hosts the door/window. */
  wall: PlacedItem;
  /** The opening it cuts, clipped to that wall. */
  opening: WallOpening;
}

/**
 * THE eligibility rule for a door/window cutting a freestanding wall, shared
 * by wall rendering (openingsOnWall) and the room outline (which must not cut
 * a second hole): the item must be a door/window, be hosted by a freestanding
 * wall under the same rule that snaps it (nearestHostWall over the outline
 * and every wall, parallel walls only), lie within half the wall thickness +
 * 1" of that wall's segment, be parallel to it, and clip to a real opening.
 * Returns null when the item does not cut any freestanding wall.
 */
export function interiorOpeningFor(item: PlacedItem, wallItems: PlacedItem[], outline: WallSeg[]): InteriorOpening | null {
  const def = getItemDef(item.defId);
  if (!def || def.category !== "doors-windows") return null;
  const hosts = interiorWallSegs(wallItems);
  if (hosts.length === 0) return null;
  const host = nearestHostWall({ x: item.x, z: item.z }, outline, hosts, {
    w: item.w ?? def.w, d: item.d ?? def.d, rotation: item.rotation,
  });
  const wallId = host ? (host.wall as HostSeg).itemId : undefined;
  const wall = wallId === undefined ? undefined : wallItems.find((i) => i.id === wallId);
  const wdef = wall && getItemDef(wall.defId);
  if (!wall || !wdef) return null;

  const L = wall.w ?? wdef.w;
  const T = wall.d ?? wdef.d;
  const ux = Math.cos(wall.rotation);
  const uz = -Math.sin(wall.rotation);
  const dx = item.x - wall.x;
  const dz = item.z - wall.z;
  const s = dx * ux + dz * uz;
  const sc = Math.max(-L / 2, Math.min(L / 2, s));
  if (!(Math.hypot(dx - ux * sc, dz - uz * sc) <= T / 2 + OPENING_FACE_SLOP)) return null;
  let diff = (item.rotation - wall.rotation) % Math.PI;
  if (diff > Math.PI / 2) diff -= Math.PI;
  if (diff < -Math.PI / 2) diff += Math.PI;
  if (!(Math.abs(diff) <= OPENING_PARALLEL_TOL)) return null;
  const ow = item.w ?? def.w;
  const lo = Math.max(-L / 2, s - ow / 2);
  const hi = Math.min(L / 2, s + ow / 2);
  if (!(hi - lo >= MIN_OPENING)) return null;
  const bottom = item.y ?? def.elevation ?? 0;
  return { wall, opening: { center: (lo + hi) / 2, width: hi - lo, bottom, top: bottom + (item.h ?? def.h) } };
}

/** A freestanding wall's segment, tagged with the item it came from. */
export interface HostSeg extends WallSeg {
  itemId?: string;
}

/** Wall segments for every freestanding wall item (both faces usable). index is -1. */
export function interiorWallSegs(items: PlacedItem[]): HostSeg[] {
  const out: HostSeg[] = [];
  for (const it of items) {
    if (!isOpeningHost(it.defId)) continue;
    const def = getItemDef(it.defId);
    if (!def) continue;
    const length = it.w ?? def.w;
    const { a, b } = wallEndpoints(it, length);
    const dir = { x: Math.cos(it.rotation), z: -Math.sin(it.rotation) };
    out.push({ index: -1, a, b, dir, normal: { x: -dir.z, z: dir.x }, length, itemId: it.id });
  }
  return out;
}

/** Interior walls must be this much closer than the outline to win a snap. */
const INTERIOR_SNAP_BIAS = 0.02;
/** A freestanding wall only hosts an item within this reach (measured from the item's back face). */
export const HOST_REACH = inches(8);

export interface HostOpts {
  /** Direction the item faces; picks the wall side when the point is on the wall line. */
  facing?: Pt;
  /** Item width: walls shorter than this cannot host it. */
  w?: number;
  /** Item depth: reach is measured from the back face (center - d/2). */
  d?: number;
  /**
   * When set, return null unless the chosen wall (outline or freestanding) is
   * within this reach of the item's back face. Unset = always snap to the
   * outline, like the Studio's drag/place.
   */
  reach?: number;
  /**
   * The item's own rotation. When set, only walls the item is parallel to
   * (either face, within tolerance) are candidates, so a perpendicular wall
   * at a T-junction can never steal the host from the wall that really holds it.
   */
  rotation?: number;
}

/**
 * Nearest wall for wall-mount snapping, considering the room outline and
 * freestanding walls. A freestanding wall only wins when it is long enough
 * for the item and within HOST_REACH of it, and closer than the outline; for
 * it the normal is flipped to the side the point is on (or `facing`, when the
 * point is on the wall line). Otherwise this is exactly nearestWall(outline).
 */
export function nearestHostWall(p: Pt, outline: WallSeg[], interior: WallSeg[], opts: HostOpts = {}): WallHit | null {
  if (opts.rotation !== undefined) {
    const ux = Math.cos(opts.rotation);
    const uz = -Math.sin(opts.rotation);
    const parallel = (seg: WallSeg) => Math.abs(ux * seg.dir.z - uz * seg.dir.x) <= Math.sin(OPENING_PARALLEL_TOL);
    outline = outline.filter(parallel);
    interior = interior.filter(parallel);
  }
  const hit = pickHostWall(p, outline, interior, opts);
  if (hit && opts.reach !== undefined && !(Math.max(0, hit.distance - (opts.d ?? 0) / 2) <= opts.reach)) return null;
  return hit;
}

function pickHostWall(p: Pt, outline: WallSeg[], interior: WallSeg[], opts: HostOpts): WallHit | null {
  const base = nearestWall(p, outline);
  const { facing, w = 0, d = 0 } = opts;
  const usable = interior.filter((seg) => seg.length >= w);
  if (usable.length === 0) return base;
  const ih = nearestWall(p, usable);
  if (!ih) return base;
  if (!(Math.max(0, ih.distance - d / 2) <= HOST_REACH)) return base;
  if (base && ih.distance + INTERIOR_SNAP_BIAS >= base.distance) return base;
  const wl = ih.wall;
  let side = (p.x - ih.point.x) * wl.normal.x + (p.z - ih.point.z) * wl.normal.z;
  if (Math.abs(side) < 1e-6 && facing) side = facing.x * wl.normal.x + facing.z * wl.normal.z;
  const wall = side < 0 ? { ...wl, normal: { x: -wl.normal.x, z: -wl.normal.z } } : wl;
  return { ...ih, wall };
}

/** Pose of a wall-mount item snapped onto a wall hit; `off` = offset along the wall normal. */
export function wallMountPose(hit: WallHit, w: number, off: number): { x: number; z: number; rotation: number } {
  // An item wider than the wall centers on it (never an inverted clamp).
  const halfFrac = Math.min(0.5, w / 2 / hit.wall.length);
  const t = Math.min(1 - halfFrac, Math.max(halfFrac, hit.t));
  return {
    x: hit.wall.a.x + hit.wall.dir.x * hit.wall.length * t + hit.wall.normal.x * off,
    z: hit.wall.a.z + hit.wall.dir.z * hit.wall.length * t + hit.wall.normal.z * off,
    rotation: wallFacingRotation(hit.wall),
  };
}

/**
 * Whether a wall-mount def snaps to freestanding walls: doors and windows only.
 * Niches stay outline-only until they can cut a pocket in a freestanding wall.
 */
export function snapsToInteriorWalls(def: { category: string; cutsWall?: boolean }): boolean {
  return def.category === "doors-windows" && !def.cutsWall;
}

/**
 * True when a door/window really cuts a freestanding wall (interiorOpeningFor),
 * so the room outline must not also cut a hole for it. False when the room has
 * no freestanding walls, and for anything that does not qualify as an opening.
 */
export function hostedByInteriorWall(item: PlacedItem, outline: WallSeg[], wallItems: PlacedItem[]): boolean {
  return interiorOpeningFor(item, wallItems, outline) !== null;
}
