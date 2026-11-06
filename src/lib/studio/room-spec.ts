// Room Studio - plain-inches "room spec" <-> DesignDoc converter.
//
// The spec is what an AI (or a human with a tape measure) writes: inches, in a
// sketch frame where x runs right and y runs DOWN the page (so "N" is up the
// page). specToDoc turns it into the meters/center-origin DesignDoc the Studio
// renders; docToSpec reads a doc back so it can be revised. Pure (no React,
// no three.js, no DB) so it is unit-testable and shared by the MCP tools.

import { z } from "zod";
import { CATALOG, CATEGORY_LABELS, getItemDef, type CatalogItem } from "./catalog";
import { DEFAULT_SURFACES, ALL_FINISHES } from "./materials";
import { newItemId, type DesignDoc, type PlacedItem, type Pt } from "./doc";
import { nearestWall, pointInPolygon, signedArea, wallSegments } from "./geometry";
import {
  HOST_REACH, interiorWallSegs, nearestHostWall, snapsToInteriorWalls, wallEndpoints, wallItemPose, wallLengthProblem,
  wallMountPose,
} from "./walls";
import { feet, inches, toInches } from "./units";

// ---------------------------------------------------------------------------
// Spec shape
// ---------------------------------------------------------------------------

const inch = z.number().finite().min(-20000).max(20000);
// [x, y] as a plain 2-element array: serializes to simple JSON Schema (no tuple/prefixItems).
const point = z.array(inch).length(2);
const dim = z.number().finite().positive().max(1200);

export const RoomSpecSchema = z.object({
  outline: z.array(point).min(3).max(100),
  heightIn: z.number().finite().min(36).max(480).optional(),
  walls: z
    .array(
      z.object({
        from: point,
        to: point,
        kind: z.enum(["full", "pony"]).optional(),
        heightIn: dim.optional(),
        thicknessIn: z.number().finite().min(2).max(24).optional(),
        label: z.string().max(120).optional(),
        finishes: z.record(z.string().max(40), z.string().max(80)).optional(),
      }),
    )
    .max(300)
    .optional(),
  items: z
    .array(
      z.object({
        type: z.string().min(1).max(80),
        at: point,
        facing: z.union([z.enum(["N", "S", "E", "W"]), z.number().finite()]).optional(),
        widthIn: dim.optional(),
        depthIn: dim.optional(),
        heightIn: dim.optional(),
        elevationIn: z.number().finite().min(0).max(480).optional(),
        label: z.string().max(120).optional(),
        finishes: z.record(z.string().max(40), z.string().max(80)).optional(),
      }),
    )
    .max(600)
    .optional(),
  floor: z.string().max(80).optional(),
  wallPaint: z.string().max(80).optional(),
  ceiling: z.string().max(80).optional(),
  wallThicknessIn: z.number().finite().min(2).max(24).optional(),
});

export type RoomSpec = z.infer<typeof RoomSpecSchema>;
export type RoomSpecItem = NonNullable<RoomSpec["items"]>[number];
export type RoomSpecWall = NonNullable<RoomSpec["walls"]>[number];

export interface SpecConversion {
  doc: DesignDoc;
  warnings: string[];
}

/** Largest outline span (either axis): 100 ft. */
const MAX_SPAN = 1200;
const DEFAULT_WALL_THICKNESS = inches(5);
/** An item's `at` this close to the outline still counts as in the room. */
const OUTSIDE_SLOP = inches(6);
const PONY_DEFAULT_H = inches(42);

const FLOOR_IDS = new Set(ALL_FINISHES.filter((f) => f.kind === "floor").map((f) => f.id));
const PAINT_IDS = new Set(ALL_FINISHES.filter((f) => f.kind === "paint").map((f) => f.id));
const FINISH_IDS = new Set(ALL_FINISHES.map((f) => f.id));

const r2 = (n: number) => Math.round(n * 100) / 100;
const fmt = (n: number) => String(r2(n));

// ---------------------------------------------------------------------------
// spec -> doc
// ---------------------------------------------------------------------------

function allFinite(v: unknown): boolean {
  if (typeof v === "number") return Number.isFinite(v);
  if (Array.isArray(v)) return v.every(allFinite);
  if (v && typeof v === "object") return Object.values(v as Record<string, unknown>).every(allFinite);
  return true;
}

/** Throws if any number anywhere in the doc is NaN/Infinity (JSON would silently store null). */
export function assertDocFinite(doc: DesignDoc): void {
  if (!allFinite(doc)) throw new Error("the converted room contains a non-finite number; check the spec's numbers");
}

const cross = (o: readonly number[], a: readonly number[], b: readonly number[]) =>
  (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

function onSegment(a: readonly number[], b: readonly number[], p: readonly number[]): boolean {
  return Math.min(a[0], b[0]) <= p[0] && p[0] <= Math.max(a[0], b[0]) && Math.min(a[1], b[1]) <= p[1] && p[1] <= Math.max(a[1], b[1]);
}

/** Closed-segment intersection (touching and collinear overlap count). */
function segmentsIntersect(a: readonly number[], b: readonly number[], c: readonly number[], d: readonly number[]): boolean {
  const o1 = cross(a, b, c);
  const o2 = cross(a, b, d);
  const o3 = cross(c, d, a);
  const o4 = cross(c, d, b);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;
  return (o1 === 0 && onSegment(a, b, c)) || (o2 === 0 && onSegment(a, b, d)) ||
    (o3 === 0 && onSegment(c, d, a)) || (o4 === 0 && onSegment(c, d, b));
}

/** Rejects outlines the Studio cannot represent: repeated points, self-crossing, spikes, oversize. */
function assertSimpleOutline(pts: readonly (readonly number[])[]): void {
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    if (p[0] === q[0] && p[1] === q[1]) throw new Error(`outline corners ${i} and ${(i + 1) % n} are the same point (zero-length edge; do not repeat the first point at the end)`);
  }
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  if (Math.max(...xs) - Math.min(...xs) > MAX_SPAN || Math.max(...ys) - Math.min(...ys) > MAX_SPAN) {
    throw new Error(`outline is larger than ${MAX_SPAN / 12} ft in one direction; check the units (inches)`);
  }
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const c = pts[(i + 2) % n];
    // adjacent edges folding back on themselves (a spike)
    if (cross(a, b, c) === 0 && (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]) < 0) {
      throw new Error(`outline doubles back on itself at corner ${(i + 1) % n}`);
    }
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // adjacent through the wrap
      if (segmentsIntersect(a, b, pts[j], pts[(j + 1) % n])) {
        throw new Error(`outline edges ${i} and ${j} cross or touch; the outline must be a simple closed shape`);
      }
    }
  }
}

function cleanFinishes(finishes: Record<string, string> | undefined, tag: string, warnings: string[]): Record<string, string> | undefined {
  if (!finishes) return undefined;
  const out: Record<string, string> = {};
  for (const [slot, id] of Object.entries(finishes)) {
    if (FINISH_IDS.has(id)) out[slot] = id;
    else warnings.push(`${tag}: finish "${id}" for slot "${slot}" is unknown; ignored.`);
  }
  return Object.keys(out).length ? out : undefined;
}

function facingRotation(facing: RoomSpecItem["facing"]): number | null {
  if (facing === undefined) return null;
  // Compass on the sketch: 0 = N (up the page), 90 = E, 180 = S, 270 = W.
  // An item's front is local +Z, rotation r puts the front along (sin r, cos r) in (x, z).
  const deg = facing === "N" ? 0 : facing === "E" ? 90 : facing === "S" ? 180 : facing === "W" ? 270 : facing;
  if (!Number.isFinite(deg)) throw new Error("facing must be N, S, E, W or a finite number of degrees");
  // compass degrees wrap: 450 == 90, -90 == 270
  const norm = ((deg % 360) + 360) % 360;
  return Math.PI - (norm * Math.PI) / 180;
}

export function specToDoc(spec: RoomSpec): SpecConversion {
  const warnings: string[] = [];
  if (!allFinite(spec)) throw new Error("spec contains a non-finite number");
  assertSimpleOutline(spec.outline);

  // Sketch inches -> centered meters (x right, z = sketch y down).
  const xs = spec.outline.map((p) => p[0]);
  const ys = spec.outline.map((p) => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const toPt = (p: readonly number[]): Pt => ({ x: inches(p[0] - cx), z: inches(p[1] - cy) });

  let points = spec.outline.map(toPt);
  const area = signedArea(points);
  if (Math.abs(area) < 1e-6) throw new Error("outline has no area (points are in a line or repeated)");
  // Studio rooms wind with positive signed area (like makeRectRoom).
  if (area < 0) points = [...points].reverse();

  const doc: DesignDoc = {
    version: 2,
    room: {
      points,
      height: spec.heightIn ? inches(spec.heightIn) : feet(9),
      wallThickness: spec.wallThicknessIn ? inches(spec.wallThicknessIn) : DEFAULT_WALL_THICKNESS,
    },
    surfaces: {
      floor: DEFAULT_SURFACES.floor,
      ceiling: DEFAULT_SURFACES.ceiling,
      walls: { all: DEFAULT_SURFACES.wall },
    },
    items: [],
  };

  if (spec.floor) {
    if (FLOOR_IDS.has(spec.floor)) doc.surfaces.floor = spec.floor;
    else warnings.push(`floor "${spec.floor}" is not a known floor finish; kept the default (${DEFAULT_SURFACES.floor}).`);
  }
  if (spec.wallPaint) {
    if (PAINT_IDS.has(spec.wallPaint)) doc.surfaces.walls = { all: spec.wallPaint };
    else warnings.push(`wallPaint "${spec.wallPaint}" is not a known paint; kept the default (${DEFAULT_SURFACES.wall}).`);
  }

  if (spec.ceiling) {
    if (PAINT_IDS.has(spec.ceiling)) doc.surfaces.ceiling = spec.ceiling;
    else warnings.push(`ceiling "${spec.ceiling}" is not a known paint; kept the default (${DEFAULT_SURFACES.ceiling}).`);
  }

  // Freestanding walls.
  (spec.walls ?? []).forEach((w, i) => {
    const a = toPt(w.from);
    const b = toPt(w.to);
    const pose = wallItemPose(a, b);
    const problem = wallLengthProblem(pose.w);
    if (problem) {
      throw new Error(`walls[${i}] is ${fmt(toInches(pose.w))}" long; walls must be between 4" and 288" (${problem === "short" ? "too short" : "too long"})`);
    }
    const pony = w.kind === "pony";
    const wallItem: PlacedItem = {
      id: newItemId(),
      defId: pony ? "pony-wall" : "interior-wall",
      x: pose.x,
      z: pose.z,
      rotation: pose.rotation,
      w: pose.w,
      ...(pony ? { h: w.heightIn ? inches(w.heightIn) : PONY_DEFAULT_H } : w.heightIn ? { h: inches(w.heightIn) } : {}),
      ...(w.thicknessIn ? { d: inches(w.thicknessIn) } : {}),
      ...(w.label ? { label: w.label } : {}),
    };
    const wallFinishes = cleanFinishes(w.finishes, `walls[${i}]`, warnings);
    if (wallFinishes) wallItem.finishes = wallFinishes;
    doc.items.push(wallItem);
  });

  // Items. Interior walls above are already in doc.items, so door/window
  // snapping sees them exactly as the Studio's drag/place does.
  const outlineWalls = wallSegments(points);
  const interior = interiorWallSegs(doc.items);

  (spec.items ?? []).forEach((s, i) => {
    const def = getItemDef(s.type);
    const tag = `items[${i}] (${s.type})`;
    if (!def) {
      warnings.push(`${tag}: unknown type; skipped. Use a catalog id from the tool description.`);
      return;
    }
    const at = toPt(s.at);
    const w = s.widthIn ? inches(s.widthIn) : def.w;
    const d = s.depthIn ? inches(s.depthIn) : def.d;

    const nearOutline = nearestWall(at, outlineWalls);
    if (!pointInPolygon(at, points) && (!nearOutline || nearOutline.distance > OUTSIDE_SLOP)) {
      warnings.push(`${tag} at [${fmt(s.at[0])}, ${fmt(s.at[1])}] is outside the room outline; placed anyway.`);
    }

    const rot = facingRotation(s.facing);
    let x = at.x;
    let z = at.z;
    let rotation = rot ?? 0;

    if (def.mount === "wall") {
      const facingVec = rot === null ? undefined : { x: Math.sin(rot), z: Math.cos(rot) };
      const hit = nearestHostWall(at, outlineWalls, snapsToInteriorWalls(def) ? interior : [], { facing: facingVec, w, d });
      if (hit && hit.distance <= HOST_REACH) {
        const off = def.category === "doors-windows" || def.cutsWall ? 0 : d / 2;
        ({ x, z, rotation } = wallMountPose(hit, w, off));
      } else {
        warnings.push(`${tag} at [${fmt(s.at[0])}, ${fmt(s.at[1])}] is not within 8" of a wall; left freestanding facing ${s.facing ?? "S"} (fine for a door in a gap between wall ends; set facing to orient it).`);
      }
    }

    const finishes = cleanFinishes(s.finishes, tag, warnings);

    const item: PlacedItem = { id: newItemId(), defId: def.id, x, z, rotation };
    if (s.elevationIn !== undefined) item.y = inches(s.elevationIn);
    if (s.widthIn) item.w = w;
    if (s.depthIn) item.d = d;
    if (s.heightIn) item.h = inches(s.heightIn);
    if (finishes) item.finishes = finishes;
    if (s.label) item.label = s.label;
    doc.items.push(item);
  });

  assertDocFinite(doc);
  return { doc, warnings };
}

// ---------------------------------------------------------------------------
// doc -> spec
// ---------------------------------------------------------------------------

function facingFromRotation(rotation: number): "N" | "E" | "S" | "W" | number {
  const deg = (((180 - (rotation * 180) / Math.PI) % 360) + 360) % 360;
  for (const [name, v] of [["N", 0], ["E", 90], ["S", 180], ["W", 270], ["N", 360]] as const) {
    if (Math.abs(deg - v) < 0.01) return name;
  }
  return Math.round(deg * 10) / 10;
}

/** Read a doc back as a spec (origin = top-left of the outline's bounding box). */
export function docToSpec(doc: DesignDoc): RoomSpec {
  const xs = doc.room.points.map((p) => p.x);
  const zs = doc.room.points.map((p) => p.z);
  const minX = Math.min(...xs);
  const minZ = Math.min(...zs);
  const toSketch = (p: Pt): [number, number] => [r2(toInches(p.x - minX)), r2(toInches(p.z - minZ))];

  const walls: RoomSpecWall[] = [];
  const items: RoomSpecItem[] = [];

  for (const it of doc.items) {
    const def = getItemDef(it.defId);
    if (!def) continue;
    if (it.defId === "interior-wall" || it.defId === "pony-wall") {
      const { a, b } = wallEndpoints(it, it.w ?? def.w);
      const pony = it.defId === "pony-wall";
      const wall: RoomSpecWall = { from: toSketch(a), to: toSketch(b), kind: pony ? "pony" : "full" };
      // pony walls always state their height (catalog default 36", spec default 42"); full walls only when overridden
      const h = it.h ?? (pony ? def.h : undefined);
      if (h !== undefined) wall.heightIn = r2(toInches(h));
      if (it.d !== undefined) wall.thicknessIn = r2(toInches(it.d));
      if (it.label) wall.label = it.label;
      if (it.finishes && Object.keys(it.finishes).length) wall.finishes = it.finishes;
      walls.push(wall);
      continue;
    }
    const out: RoomSpecItem = { type: it.defId, at: toSketch({ x: it.x, z: it.z }), facing: facingFromRotation(it.rotation) };
    if (it.w !== undefined) out.widthIn = r2(toInches(it.w));
    if (it.d !== undefined) out.depthIn = r2(toInches(it.d));
    if (it.h !== undefined) out.heightIn = r2(toInches(it.h));
    if (it.y !== undefined) out.elevationIn = r2(toInches(it.y));
    if (it.label) out.label = it.label;
    if (it.finishes && Object.keys(it.finishes).length) out.finishes = it.finishes;
    items.push(out);
  }

  const spec: RoomSpec = {
    outline: doc.room.points.map(toSketch),
    heightIn: r2(toInches(doc.room.height)),
    floor: doc.surfaces.floor,
    wallPaint: doc.surfaces.walls.all,
  };
  if (doc.surfaces.ceiling !== DEFAULT_SURFACES.ceiling) spec.ceiling = doc.surfaces.ceiling;
  if (Math.abs(doc.room.wallThickness - DEFAULT_WALL_THICKNESS) > 1e-9) spec.wallThicknessIn = r2(toInches(doc.room.wallThickness));
  if (walls.length) spec.walls = walls;
  if (items.length) spec.items = items;
  return spec;
}

// ---------------------------------------------------------------------------
// Tool help text (what an AI needs to write a spec)
// ---------------------------------------------------------------------------

function catalogHelp(): string {
  const byCat = new Map<string, CatalogItem[]>();
  for (const c of CATALOG) {
    const list = byCat.get(c.category) ?? [];
    list.push(c);
    byCat.set(c.category, list);
  }
  const lines: string[] = [];
  for (const [cat, list] of byCat) {
    const label = CATEGORY_LABELS[cat as keyof typeof CATEGORY_LABELS] ?? cat;
    lines.push(`${label}: ` + list.map((c) => `${c.id} (${r2(toInches(c.w))}x${r2(toInches(c.d))})`).join(", "));
  }
  return lines.join("\n");
}

export const ROOM_SPEC_EXAMPLE: RoomSpec = {
  outline: [[0, 0], [96, 0], [96, 60], [0, 60]],
  heightIn: 96,
  walls: [{ from: [40, 0], to: [40, 30], kind: "full" }],
  items: [
    { type: "toilet", at: [82, 14], facing: "W" },
    { type: "door-single", at: [20, 60] },
    { type: "window-single", at: [96, 30], elevationIn: 42 },
  ],
  floor: "floor-oak-natural",
  wallPaint: "paint-soft-chalk",
};

export const ROOM_SPEC_FORMAT =
  "SPEC FORMAT (all lengths in INCHES; sketch frame: x grows to the right, y grows DOWN the page, so north is up; the origin is arbitrary, the room is centered for you).\n" +
  "EXAMPLE (8x5 ft half bath): " + JSON.stringify(ROOM_SPEC_EXAMPLE) + "\n" +
  "FIELDS: { outline: [[x,y],...] (closed polygon, 3+ corners, do not repeat the first point), heightIn?: ceiling height (default 108), " +
  "walls?: [{ from:[x,y], to:[x,y], kind?: 'full'|'pony', heightIn?, thicknessIn?, label?, finishes? }] (freestanding interior walls drawn center-line to center-line, 4in to 288in long, ~4.5in thick; pony = 42in half wall unless heightIn; a doorway is a wall with a door/doorway-open item in it, or two shorter walls with a gap), " +
  "items?: [{ type: <catalog id>, at:[x,y] (item CENTER), facing?: 'N'|'S'|'E'|'W' or compass degrees (0=N,90=E,180=S,270=W) = the direction the item's FRONT points (a toilet against the west wall faces E), widthIn?, depthIn?, heightIn?, elevationIn? (bottom above floor, e.g. a window sill), label?, finishes?: {slot: finishId} }], " +
  "floor?: floor finish id, wallPaint?: paint finish id, ceiling?: paint id, wallThicknessIn? (outer walls, default 5) }.\n" +
  "Doors, windows and doorway-open (wall-mount items; niches snap to the outline only) snap onto the nearest wall (room outline or an interior wall) when their `at` is within 8in of it, aligned and flush; their `at` only needs to be near the wall. They face into the room (for an interior wall, the side that `at` or `facing` is on). A door in an interior wall cuts a real opening. A wall-mount item farther than 8in from any wall is left freestanding and reported as a warning. " +
  "All other items are placed exactly at `at` with their center there; they do NOT auto-snap, so compute the center (e.g. a 28in-deep toilet whose back touches the west wall at x=0 has center x=14 and faces E). " +
  "Unknown types or items outside the outline come back in `warnings` (unknown types are skipped).\n";

/** Format + the full catalog id list (for build_room_design's description). */
export const ROOM_SPEC_HELP = ROOM_SPEC_FORMAT + "CATALOG IDS (widthxdepth in inches): \n" + catalogHelp();
