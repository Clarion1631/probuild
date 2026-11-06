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
  interiorWallSegs, nearestHostWall, snapsToInteriorWalls, wallEndpoints, wallItemPose, wallMountPose,
} from "./walls";
import { feet, inches, toInches } from "./units";

// ---------------------------------------------------------------------------
// Spec shape
// ---------------------------------------------------------------------------

const inch = z.number().finite().min(-20000).max(20000);
const point = z.tuple([inch, inch]);
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
});

export type RoomSpec = z.infer<typeof RoomSpecSchema>;
export type RoomSpecItem = NonNullable<RoomSpec["items"]>[number];
export type RoomSpecWall = NonNullable<RoomSpec["walls"]>[number];

export interface SpecConversion {
  doc: DesignDoc;
  warnings: string[];
}

/** A wall-mount item farther than this from any wall is left freestanding (with a warning). */
const WALL_MOUNT_REACH = inches(8);
/** An item's `at` this close to the outline still counts as in the room. */
const OUTSIDE_SLOP = inches(6);
const MIN_WALL = inches(1);
const SHORT_WALL = inches(4);
const PONY_DEFAULT_H = inches(42);

const FLOOR_IDS = new Set(ALL_FINISHES.filter((f) => f.kind === "floor").map((f) => f.id));
const PAINT_IDS = new Set(ALL_FINISHES.filter((f) => f.kind === "paint").map((f) => f.id));
const FINISH_IDS = new Set(ALL_FINISHES.map((f) => f.id));

const r2 = (n: number) => Math.round(n * 100) / 100;
const fmt = (n: number) => String(r2(n));

// ---------------------------------------------------------------------------
// spec -> doc
// ---------------------------------------------------------------------------

function facingRotation(facing: RoomSpecItem["facing"]): number | null {
  if (facing === undefined) return null;
  // Compass on the sketch: 0 = N (up the page), 90 = E, 180 = S, 270 = W.
  // An item's front is local +Z, rotation r puts the front along (sin r, cos r) in (x, z).
  const deg = facing === "N" ? 0 : facing === "E" ? 90 : facing === "S" ? 180 : facing === "W" ? 270 : facing;
  return Math.PI - (deg * Math.PI) / 180;
}

export function specToDoc(spec: RoomSpec): SpecConversion {
  const warnings: string[] = [];

  // Sketch inches -> centered meters (x right, z = sketch y down).
  const xs = spec.outline.map((p) => p[0]);
  const ys = spec.outline.map((p) => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const toPt = (p: readonly [number, number]): Pt => ({ x: inches(p[0] - cx), z: inches(p[1] - cy) });

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
      wallThickness: inches(5),
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

  // Freestanding walls.
  (spec.walls ?? []).forEach((w, i) => {
    const a = toPt(w.from);
    const b = toPt(w.to);
    const pose = wallItemPose(a, b);
    if (pose.w < MIN_WALL) {
      warnings.push(`walls[${i}] is shorter than 1" and was skipped.`);
      return;
    }
    if (pose.w < SHORT_WALL) warnings.push(`walls[${i}] is only ${fmt(toInches(pose.w))}" long (the Studio minimum is 4").`);
    const pony = w.kind === "pony";
    doc.items.push({
      id: newItemId(),
      defId: pony ? "pony-wall" : "interior-wall",
      x: pose.x,
      z: pose.z,
      rotation: pose.rotation,
      w: pose.w,
      ...(pony ? { h: w.heightIn ? inches(w.heightIn) : PONY_DEFAULT_H } : w.heightIn ? { h: inches(w.heightIn) } : {}),
    });
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
      const hit = nearestHostWall(at, outlineWalls, snapsToInteriorWalls(def) ? interior : [], facingVec);
      if (hit && hit.distance <= WALL_MOUNT_REACH) {
        const off = def.category === "doors-windows" || def.cutsWall ? 0 : d / 2;
        ({ x, z, rotation } = wallMountPose(hit, w, off));
      } else {
        warnings.push(`${tag} at [${fmt(s.at[0])}, ${fmt(s.at[1])}] is not within 8" of a wall; left freestanding facing ${s.facing ?? "S"}.`);
      }
    }

    let finishes: Record<string, string> | undefined;
    if (s.finishes) {
      finishes = {};
      for (const [slot, id] of Object.entries(s.finishes)) {
        if (FINISH_IDS.has(id)) finishes[slot] = id;
        else warnings.push(`${tag}: finish "${id}" for slot "${slot}" is unknown; ignored.`);
      }
      if (Object.keys(finishes).length === 0) finishes = undefined;
    }

    const item: PlacedItem = { id: newItemId(), defId: def.id, x, z, rotation };
    if (s.elevationIn !== undefined) item.y = inches(s.elevationIn);
    if (s.widthIn) item.w = w;
    if (s.depthIn) item.d = d;
    if (s.heightIn) item.h = inches(s.heightIn);
    if (finishes) item.finishes = finishes;
    if (s.label) item.label = s.label;
    doc.items.push(item);
  });

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
      const h = it.h ?? (pony ? PONY_DEFAULT_H : undefined);
      if (h !== undefined && !(pony && Math.abs(h - PONY_DEFAULT_H) < 1e-6)) wall.heightIn = r2(toInches(h));
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
  "SPEC FORMAT (all lengths in INCHES; sketch frame: x grows to the right, y grows DOWN the page, so north is up; the origin is arbitrary, the room is centered for you):\n" +
  "{ outline: [[x,y],...] (closed polygon, 3+ corners, do not repeat the first point), heightIn?: ceiling height (default 108), " +
  "walls?: [{ from:[x,y], to:[x,y], kind?: 'full'|'pony', heightIn? }] (freestanding interior walls drawn center-line to center-line, ~4.5in thick; pony = 42in half wall unless heightIn; a doorway is a wall with a door/doorway-open item in it, or two shorter walls with a gap), " +
  "items?: [{ type: <catalog id>, at:[x,y] (item CENTER), facing?: 'N'|'S'|'E'|'W' or compass degrees (0=N,90=E,180=S,270=W) = the direction the item's FRONT points (a toilet against the west wall faces E), widthIn?, depthIn?, heightIn?, elevationIn? (bottom above floor, e.g. a window sill), label?, finishes?: {slot: finishId} }], " +
  "floor?: floor finish id, wallPaint?: paint finish id }.\n" +
  "Doors, windows, doorway-open and niches (wall-mount items) snap onto the nearest wall (room outline or an interior wall) when their `at` is within 8in of it, aligned and flush; their `at` only needs to be near the wall. They face into the room (for an interior wall, the side that `at` or `facing` is on). A door in an interior wall cuts a real opening. A wall-mount item farther than 8in from any wall is left freestanding and reported as a warning. " +
  "All other items are placed exactly at `at` with their center there; they do NOT auto-snap, so compute the center (e.g. a 28in-deep toilet whose back touches the west wall at x=0 has center x=14 and faces E). " +
  "Unknown types or items outside the outline come back in `warnings` (unknown types are skipped).\n" +
  "EXAMPLE (8x5 ft half bath): " + JSON.stringify(ROOM_SPEC_EXAMPLE) + "\n";

/** Format + the full catalog id list (for build_room_design's description). */
export const ROOM_SPEC_HELP = ROOM_SPEC_FORMAT + "CATALOG IDS (widthxdepth in inches): \n" + catalogHelp();
