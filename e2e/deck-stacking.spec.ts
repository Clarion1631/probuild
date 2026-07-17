// Room Studio deck auto-stacking - pure unit coverage of lib/studio/stacking
// (no page, no data; runs in-process). Guards the rotated-footprint math and
// the commit-time restack rules that keep floor items on top of decks.

import { test, expect } from "@playwright/test";
import { deckTopYAt, restackFloorItems } from "@/lib/studio/stacking";
import type { PlacedItem } from "@/lib/studio/doc";

const IN = (n: number) => n * 0.0254;

// Unrotated deck, default catalog size 144x96in, h=6in, at origin.
const deck: PlacedItem = { id: "d1", defId: "deck-platform", x: 0, z: 0, rotation: 0 };
// Resized deck 1.5x1.5m rotated 45deg.
const rotated: PlacedItem = {
  id: "d2", defId: "deck-platform", x: 1.562, z: -0.197, rotation: Math.PI / 4, w: 1.5, d: 1.5,
};

test.describe("deckTopYAt", () => {
  test("axis-aligned footprint", () => {
    expect(deckTopYAt([deck], { x: 0, z: 0 })).toBeCloseTo(IN(6), 10);
    expect(deckTopYAt([deck], { x: IN(71), z: 0 })).toBeCloseTo(IN(6), 10);
    expect(deckTopYAt([deck], { x: IN(73), z: 0 })).toBeUndefined();
    expect(deckTopYAt([deck], { x: 0, z: IN(49) })).toBeUndefined();
  });

  test("rotated footprint uses the deck's local frame", () => {
    expect(deckTopYAt([rotated], { x: 1.562, z: -0.197 })).toBeCloseTo(IN(6), 10);
    // 1.0m along -x: outside the 0.75 half-extent AABB but inside the rotated
    // square (vertex reach along world axes = 0.75 * sqrt(2) ~ 1.06).
    expect(deckTopYAt([rotated], { x: 0.562, z: -0.197 })).toBeCloseTo(IN(6), 10);
    // (+0.6, +0.6): |dx+dz|/sqrt(2) = 0.849 > 0.75 - inside the AABB but
    // outside the rotated square.
    expect(deckTopYAt([rotated], { x: 2.162, z: 0.403 })).toBeUndefined();
    expect(deckTopYAt([rotated], { x: 0.962, z: -0.797 })).toBeUndefined();
  });

  test("deck h override and overlapping decks", () => {
    const tall: PlacedItem = { id: "d3", defId: "deck-platform", x: 0, z: 0, rotation: 0, h: IN(18) };
    expect(deckTopYAt([tall], { x: 0, z: 0 })).toBeCloseTo(IN(18), 10);
    // overlapping decks yield the highest surface
    expect(deckTopYAt([deck, tall], { x: 0, z: 0 })).toBeCloseTo(IN(18), 10);
  });

  test("excludes the dragged deck itself and ignores non-decks", () => {
    expect(deckTopYAt([deck], { x: 0, z: 0 }, "d1")).toBeUndefined();
    const sofa: PlacedItem = { id: "s1", defId: "outdoor-sofa", x: 0, z: 0, rotation: 0 };
    expect(deckTopYAt([sofa], { x: 0, z: 0 })).toBeUndefined();
  });
});

test.describe("restackFloorItems", () => {
  test("re-derives floor elevations, leaves other mounts alone", () => {
    const chairOn: PlacedItem = { id: "c1", defId: "patio-chair", x: 0.5, z: 0, rotation: 0 };
    const chairOff: PlacedItem = { id: "c2", defId: "patio-chair", x: 10, z: 10, rotation: 0, y: IN(6) };
    const sconce: PlacedItem = { id: "w1", defId: "sconce", x: 0.5, z: 0, rotation: 0, y: IN(60) };
    const out = restackFloorItems([deck, chairOn, chairOff, sconce]);
    expect(out.find((i) => i.id === "c1")?.y).toBeCloseTo(IN(6), 10);
    expect(out.find((i) => i.id === "c2")?.y).toBeUndefined();
    expect(out.find((i) => i.id === "w1")?.y).toBeCloseTo(IN(60), 10);
    expect(out.find((i) => i.id === "d1")?.y).toBeUndefined();
  });

  test("returns the same array when nothing moves", () => {
    const settled: PlacedItem[] = [
      deck,
      { id: "c1", defId: "patio-chair", x: 0.5, z: 0, rotation: 0, y: IN(6) },
    ];
    expect(restackFloorItems(settled)).toBe(settled);
  });
});
