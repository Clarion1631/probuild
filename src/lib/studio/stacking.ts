// Room Studio - deck auto-stacking. Floor-mounted items ride on top of deck
// platforms: their `y` is derived from whichever deck their center sits on
// (undefined = plain floor). Recomputed on commit only - never per frame.

import type { PlacedItem } from "./doc";
import { getItemDef } from "./catalog";

const DECK_DEF_ID = "deck-platform";

export function isDeckPlatform(defId: string): boolean {
  return defId === DECK_DEF_ID;
}

/**
 * Top-surface Y of the deck platform under `p`, or undefined when `p` is
 * over the plain floor. Overlapping decks yield the highest surface.
 */
export function deckTopYAt(
  items: PlacedItem[],
  p: { x: number; z: number },
  excludeId?: string,
): number | undefined {
  let top: number | undefined;
  for (const it of items) {
    if (it.defId !== DECK_DEF_ID || it.id === excludeId) continue;
    const def = getItemDef(it.defId);
    if (!def) continue;
    const w = it.w ?? def.w;
    const d = it.d ?? def.d;
    const h = it.h ?? def.h;
    const base = it.y ?? def.elevation ?? 0;
    // Express p in the deck's local frame (inverse of the three.js Y rotation)
    // and test against the half-extents of its footprint.
    const dx = p.x - it.x;
    const dz = p.z - it.z;
    const cos = Math.cos(it.rotation);
    const sin = Math.sin(it.rotation);
    const lx = dx * cos - dz * sin;
    const lz = dx * sin + dz * cos;
    if (Math.abs(lx) > w / 2 || Math.abs(lz) > d / 2) continue;
    const t = base + h;
    if (top === undefined || t > top) top = t;
  }
  return top;
}

/**
 * Re-derive the elevation of every floor-mounted item from the decks in
 * `items`. Call after a deck platform is added, edited, or removed so items
 * standing on it don't float or intersect. Wall/ceiling/counter mounts and
 * the decks themselves are untouched. Returns `items` unchanged when no
 * elevation moved.
 */
export function restackFloorItems(items: PlacedItem[]): PlacedItem[] {
  let changed = false;
  const next = items.map((it) => {
    if (it.defId === DECK_DEF_ID) return it;
    const def = getItemDef(it.defId);
    if (!def || def.mount !== "floor") return it;
    const y = deckTopYAt(items, { x: it.x, z: it.z }, it.id);
    if (y === it.y) return it;
    changed = true;
    return { ...it, y };
  });
  return changed ? next : items;
}
