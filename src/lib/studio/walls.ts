// Room Studio - shared wall math. Pure (no React, no three.js).
//
// A straight wall from a to b (meters, x/z plane) is a catalog item whose
// center is the midpoint, `w` is the length, and rotation (three.js Y) is
// atan2(-(b.z - a.z), b.x - a.x). The item's local +X maps to (cos r, -sin r).

import type { Pt, PlacedItem } from "./doc";
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
