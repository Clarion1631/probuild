// Room Studio - photoreal render prompt. Builds the Gemini image-to-image
// instruction from the design doc so the AI knows the real materials
// (including org-library finishes) and stays faithful to the layout.

import type { DesignDoc } from "./doc";
import { getFinish } from "./materials";
import { getItemDef } from "./catalog";
import { polygonBounds } from "./geometry";

const M_TO_FT = 3.28084;

/** Resolve a finish id to a display name; library ids come from the DB map. */
function finishName(id: string | undefined, libNames: Map<string, string>): string | null {
  if (!id) return null;
  if (id.startsWith("lib-")) return libNames.get(id) ?? null;
  const f = getFinish(id, "paint-soft-chalk");
  return f.id === id ? f.name : null;
}

/** Collect every lib-* finish id referenced by the doc (for one DB lookup). */
export function collectLibraryFinishIds(doc: DesignDoc): string[] {
  const ids = new Set<string>();
  const add = (v: string | undefined) => {
    if (v?.startsWith("lib-")) ids.add(v);
  };
  add(doc.surfaces.floor);
  add(doc.surfaces.ceiling);
  Object.values(doc.surfaces.walls ?? {}).forEach(add);
  for (const item of doc.items) Object.values(item.finishes ?? {}).forEach(add);
  return [...ids];
}

/** Library products aren't in the server-side registry; the route passes
 *  their names/default finishes from CatalogProduct rows, keyed by defId. */
export type ProductInfo = Map<string, { name: string; finishes: Record<string, string> }>;

export function buildRenderPrompt(
  doc: DesignDoc,
  roomType: string,
  libNames: Map<string, string>,
  products: ProductInfo = new Map(),
): string {
  const bounds = polygonBounds(doc.room.points);
  const outdoor = !!doc.room.outdoor;
  const dims = `${(bounds.width * M_TO_FT).toFixed(0)}ft x ${(bounds.length * M_TO_FT).toFixed(0)}ft, ${(doc.room.height * M_TO_FT).toFixed(0)}ft ${outdoor ? "fence/structure height" : "ceiling"}`;

  const floor = finishName(doc.surfaces.floor, libNames);
  const wallPaints = [...new Set(
    Object.values(doc.surfaces.walls ?? {})
      .map((id) => finishName(id, libNames))
      .filter(Boolean),
  )] as string[];

  // Item inventory: names + the finishes that matter visually.
  const lines: string[] = [];
  const counted = new Map<string, number>();
  for (const item of doc.items) {
    const def = getItemDef(item.defId);
    const prod = !def ? products.get(item.defId) : undefined;
    if (!def && !prod) continue;
    const name = def?.name ?? prod!.name;
    const finishes = { ...(def?.finishes ?? prod?.finishes), ...item.finishes };
    const fin = ["cabinet", "counter", "tile", "paint", "fabric", "wood", "metal"]
      .map((slot) => finishName(finishes[slot], libNames))
      .filter(Boolean)
      .join(", ");
    const key = `${name}${fin ? ` (${fin})` : ""}`;
    counted.set(key, (counted.get(key) ?? 0) + 1);
  }
  for (const [key, n] of counted) lines.push(n > 1 ? `${n}x ${key}` : key);

  return [
    outdoor
      ? "This is a flat-shaded 3D mockup of a real outdoor living space. Re-render it as a REAL PHOTOGRAPH -"
      : "This is a flat-shaded 3D mockup of a real room. Re-render it as a REAL PHOTOGRAPH -",
    outdoor
      ? "a professional landscape/exterior photo shot on a full-frame DSLR, golden-hour light, open sky overhead."
      : "a professional interior-design magazine photo shot on a full-frame DSLR.",
    outdoor
      ? "Keep the camera angle, yard shape, and the position of every structure and plant EXACTLY as shown,"
      : "Keep the camera angle, room shape, and the position of every fixture EXACTLY as shown,",
    "but completely replace the CG look: photorealistic materials with visible texture",
    outdoor
      ? "(real grass blades, wood grain on decking and fences, stone pavers, dense foliage on trees and shrubs),"
      : "(tile grout lines, painted drywall, wood grain, brushed metal, glass with real reflections),",
    outdoor
      ? "natural sunlight with soft contact shadows and a realistic sky."
      : "global-illumination lighting with soft contact shadows, warm natural light, gentle vignette.",
    "",
    `${outdoor ? "Outdoor space" : "Room"}: ${roomType}, ${dims}.`,
    floor ? `${outdoor ? "Ground" : "Floor"}: ${floor}.` : "",
    wallPaints.length ? `${outdoor ? "Fence/siding" : "Wall paint"}: ${wallPaints.join(", ")}.` : "",
    lines.length ? `Furnishings and fixtures (do not add, remove, or move any): ${lines.join("; ")}.` : "",
    "",
    outdoor
      ? "Add only minimal staging consistent with a finished landscape (throw pillows, a few potted plants)."
      : "Add only minimal staging consistent with a finished home (folded towels, a plant, small decor).",
    outdoor
      ? "Do not change structures, furniture, fences, plantings, or their colors."
      : "Do not change cabinets, fixtures, walls, doors, windows, or their colors.",
  ].filter(Boolean).join("\n");
}
