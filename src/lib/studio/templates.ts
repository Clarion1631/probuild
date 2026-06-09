// Room Studio - seeded room templates (v2 DesignDoc).
//
// Every template is a complete, styled starting point: room shell, surfaces,
// and placed items from the studio catalog. Creating from a template should
// feel like walking into a finished show room, not an empty box.

import { feet, inches } from "./units";
import type { DesignDoc, PlacedItem } from "./doc";
import { makeRectRoom, makeLShapeRoom, newItemId } from "./doc";
import { DEFAULT_SURFACES } from "./materials";

export type RoomType = "kitchen" | "bathroom" | "laundry" | "bedroom" | "other";

export interface RoomTemplate {
  key: string;
  label: string;
  roomType: RoomType;
  widthFt: number;
  lengthFt: number;
  description: string;
  build: () => DesignDoc;
}

const ft = feet;
const IN = inches;

interface SeedItem {
  defId: string;
  x: number;
  z: number;
  /** Degrees, 0 = facing south (+z). */
  deg?: number;
  y?: number;
  w?: number;
  d?: number;
  finishes?: Record<string, string>;
}

function doc(
  room: DesignDoc["room"],
  surfaces: Partial<DesignDoc["surfaces"]>,
  seeds: SeedItem[],
): DesignDoc {
  const items: PlacedItem[] = seeds.map((s) => ({
    id: newItemId(),
    defId: s.defId,
    x: s.x,
    z: s.z,
    y: s.y,
    w: s.w,
    d: s.d,
    rotation: ((s.deg ?? 0) * Math.PI) / 180,
    finishes: s.finishes,
  }));
  return {
    version: 2,
    room,
    surfaces: {
      floor: surfaces.floor ?? DEFAULT_SURFACES.floor,
      ceiling: surfaces.ceiling ?? DEFAULT_SURFACES.ceiling,
      walls: surfaces.walls ?? { all: DEFAULT_SURFACES.wall },
    },
    items,
  };
}

// Wall reference for rect rooms: north wall at z = -L/2 (items there face
// south, deg 0); south z = +L/2 (deg 180); west x = -W/2 (deg 90); east (deg -90).

function kitchenLShape(): DesignDoc {
  const W = ft(12);
  const L = ft(10);
  const zN = -L / 2 + IN(12.5); // base-cabinet row center off north wall
  const xW = -W / 2 + IN(12.5); // base row center off west wall
  return doc(makeRectRoom(W, L, ft(9)), { floor: "floor-oak-natural", walls: { all: "paint-soft-chalk" } }, [
    // north run, west to east
    { defId: "base-corner", x: -W / 2 + IN(18), z: -L / 2 + IN(18) },
    { defId: "base-drawers", x: -W / 2 + IN(48), z: zN },
    { defId: "base-sink", x: -W / 2 + IN(78), z: zN, w: IN(36) },
    { defId: "dishwasher", x: -W / 2 + IN(108), z: zN },
    { defId: "range-30", x: -W / 2 + IN(135), z: zN },
    // west run heading south
    { defId: "base-door", x: xW, z: -L / 2 + IN(48), deg: 90 },
    { defId: "fridge-french", x: xW + IN(3), z: -L / 2 + IN(81), deg: 90 },
    // uppers
    { defId: "wall-cab", x: -W / 2 + IN(48), z: -L / 2 + IN(6.5) },
    { defId: "wall-cab-glass", x: -W / 2 + IN(108), z: -L / 2 + IN(6.5) },
    { defId: "range-hood", x: -W / 2 + IN(135), z: -L / 2 + IN(10) },
    { defId: "window-kitchen", x: -W / 2 + IN(78), z: -L / 2 },
    // lighting + styling
    { defId: "recessed", x: -ft(2), z: 0 },
    { defId: "recessed", x: ft(2), z: 0 },
    { defId: "flush-mount", x: 0, z: ft(2.5) },
    { defId: "plant-large", x: W / 2 - IN(14), z: L / 2 - IN(14) },
    { defId: "door-single", x: W / 2 - IN(28), z: L / 2 },
  ]);
}

function kitchenGalley(): DesignDoc {
  const W = ft(8);
  const L = ft(12);
  const xW = -W / 2 + IN(12.5);
  const xE = W / 2 - IN(12.5);
  return doc(makeRectRoom(W, L, ft(9)), { floor: "floor-walnut", walls: { all: "paint-pure-white" } }, [
    { defId: "base-sink", x: xW, z: -ft(2), deg: 90 },
    { defId: "dishwasher", x: xW, z: ft(0.2), deg: 90 },
    { defId: "base-drawers", x: xW, z: ft(2.3), deg: 90 },
    { defId: "fridge-french", x: xE - IN(3), z: -ft(3.4), deg: -90 },
    { defId: "range-30", x: xE, z: -ft(0.5), deg: -90 },
    { defId: "base-door", x: xE, z: ft(1.8), deg: -90 },
    { defId: "wall-cab", x: -W / 2 + IN(6.5), z: -ft(2), deg: 90 },
    { defId: "wall-cab", x: -W / 2 + IN(6.5), z: ft(2.3), deg: 90 },
    { defId: "range-hood", x: W / 2 - IN(10), z: -ft(0.5), deg: -90 },
    { defId: "window-single", x: 0, z: -L / 2 },
    { defId: "recessed", x: 0, z: -ft(3) },
    { defId: "recessed", x: 0, z: 0 },
    { defId: "recessed", x: 0, z: ft(3) },
    { defId: "doorway-open", x: 0, z: L / 2 },
  ]);
}

function kitchenUShape(): DesignDoc {
  const W = ft(12);
  const L = ft(12);
  const zN = -L / 2 + IN(12.5);
  const xW = -W / 2 + IN(12.5);
  const xE = W / 2 - IN(12.5);
  return doc(makeRectRoom(W, L, ft(9)), { floor: "floor-oak-white", walls: { all: "paint-agreeable-greige" } }, [
    { defId: "base-corner", x: -W / 2 + IN(18), z: -L / 2 + IN(18) },
    { defId: "base-corner", x: W / 2 - IN(18), z: -L / 2 + IN(18), deg: -90 },
    { defId: "base-sink", x: 0, z: zN, w: IN(36) },
    { defId: "dishwasher", x: IN(30), z: zN },
    { defId: "base-drawers", x: -IN(30), z: zN },
    { defId: "fridge-french", x: xW + IN(3), z: -ft(1), deg: 90 },
    { defId: "base-door", x: xW, z: ft(1.5), deg: 90 },
    { defId: "range-30", x: xE, z: -ft(1), deg: -90 },
    { defId: "base-cooktop", x: xE, z: ft(1.6), deg: -90, w: IN(30) },
    { defId: "range-hood", x: W / 2 - IN(10), z: -ft(1), deg: -90 },
    { defId: "wall-cab", x: -IN(30), z: -L / 2 + IN(6.5) },
    { defId: "wall-cab", x: IN(30), z: -L / 2 + IN(6.5) },
    { defId: "window-kitchen", x: 0, z: -L / 2 },
    { defId: "recessed", x: -ft(2.5), z: ft(0.5) },
    { defId: "recessed", x: ft(2.5), z: ft(0.5) },
    { defId: "flush-mount", x: 0, z: ft(3) },
    { defId: "doorway-open", x: 0, z: L / 2, w: IN(48) },
  ]);
}

function kitchenIsland(): DesignDoc {
  const W = ft(14);
  const L = ft(16);
  const zN = -L / 2 + IN(12.5);
  return doc(makeRectRoom(W, L, ft(10)), { floor: "floor-oak-natural", walls: { all: "paint-soft-chalk" } }, [
    { defId: "base-corner", x: -W / 2 + IN(18), z: -L / 2 + IN(18) },
    { defId: "base-drawers", x: -W / 2 + IN(48), z: zN },
    { defId: "base-sink", x: -W / 2 + IN(81), z: zN, w: IN(36) },
    { defId: "dishwasher", x: -W / 2 + IN(111), z: zN },
    { defId: "range-36-pro", x: -W / 2 + IN(138), z: zN },
    { defId: "wall-cab", x: -W / 2 + IN(48), z: -L / 2 + IN(6.5) },
    { defId: "wall-cab-glass", x: -W / 2 + IN(111), z: -L / 2 + IN(6.5) },
    { defId: "range-hood", x: -W / 2 + IN(138), z: -L / 2 + IN(10), w: IN(42) },
    { defId: "oven-tower", x: W / 2 - IN(16), z: -L / 2 + IN(16) },
    { defId: "fridge-french", x: W / 2 - IN(16), z: -L / 2 + IN(50), deg: -90 },
    { defId: "window-double", x: -W / 2 + IN(81), z: -L / 2 },
    { defId: "island-seating", x: -ft(0.5), z: ft(1), w: IN(84) },
    { defId: "island-pendants", x: -ft(0.5), z: ft(1), w: IN(60) },
    { defId: "counter-stool", x: -ft(2.2), z: ft(2.8), deg: 180 },
    { defId: "counter-stool", x: -ft(0.5), z: ft(2.8), deg: 180 },
    { defId: "counter-stool", x: ft(1.2), z: ft(2.8), deg: 180 },
    { defId: "recessed", x: -ft(3.5), z: -ft(1) },
    { defId: "recessed", x: ft(2.5), z: -ft(1) },
    { defId: "recessed", x: -ft(3.5), z: ft(4) },
    { defId: "recessed", x: ft(2.5), z: ft(4) },
    { defId: "plant-large", x: W / 2 - IN(16), z: L / 2 - IN(16) },
    { defId: "door-sliding-glass", x: 0, z: L / 2 },
  ]);
}

function bathMaster(): DesignDoc {
  const W = ft(10);
  const L = ft(12);
  return doc(makeRectRoom(W, L, ft(9)), { floor: "floor-tile-marble", walls: { all: "paint-sky-wash" } }, [
    { defId: "vanity-double", x: -W / 2 + IN(11), z: -ft(1), deg: 90, w: IN(72) },
    { defId: "mirror-round", x: -W / 2, z: -ft(2.5), deg: 90 },
    { defId: "mirror-round", x: -W / 2, z: ft(0.5), deg: 90 },
    { defId: "sconce", x: -W / 2, z: -ft(1), deg: 90 },
    { defId: "tub-freestanding", x: ft(1.5), z: -L / 2 + IN(20) },
    { defId: "shower-glass", x: W / 2 - IN(19), z: -L / 2 + IN(26), deg: -90, w: IN(48) },
    { defId: "toilet", x: W / 2 - IN(15), z: ft(2.5), deg: -90 },
    { defId: "window-single", x: 0, z: -L / 2, y: IN(40), w: IN(28) },
    { defId: "flush-mount", x: 0, z: 0 },
    { defId: "recessed", x: W / 2 - IN(19), z: -L / 2 + IN(26) },
    { defId: "plant-small", x: -W / 2 + IN(24), z: -L / 2 + IN(10), y: 0 },
    { defId: "door-single", x: -ft(1.5), z: L / 2 },
  ]);
}

function bathGuest(): DesignDoc {
  const W = ft(8);
  const L = ft(8);
  return doc(makeRectRoom(W, L, ft(8)), { floor: "floor-tile-porcelain", walls: { all: "paint-rainwashed" } }, [
    { defId: "vanity-36", x: -W / 2 + IN(11), z: -ft(1.2), deg: 90 },
    { defId: "mirror-round", x: -W / 2, z: -ft(1.2), deg: 90 },
    { defId: "toilet", x: -W / 2 + IN(15), z: ft(2), deg: 90 },
    { defId: "tub-alcove", x: ft(1.4), z: -L / 2 + IN(17), w: IN(60) },
    { defId: "flush-mount", x: 0, z: ft(0.5) },
    { defId: "door-single", x: ft(0.5), z: L / 2 },
  ]);
}

function bathHalf(): DesignDoc {
  const W = ft(5);
  const L = ft(8);
  return doc(makeRectRoom(W, L, ft(8)), { floor: "floor-tile-slate", walls: { all: "paint-hale-navy" } }, [
    { defId: "pedestal-sink", x: 0, z: -L / 2 + IN(11) },
    { defId: "mirror-round", x: 0, z: -L / 2, w: IN(24) },
    { defId: "sconce", x: -IN(16), z: -L / 2 },
    { defId: "sconce", x: IN(16), z: -L / 2 },
    { defId: "toilet", x: 0, z: -ft(0.3) },
    { defId: "flush-mount", x: 0, z: ft(1) },
    { defId: "art-frame", x: W / 2, z: 0, deg: -90, w: IN(20) },
    { defId: "door-single", x: 0, z: L / 2 },
  ]);
}

function livingRoom(): DesignDoc {
  const W = ft(16);
  const L = ft(14);
  return doc(makeRectRoom(W, L, ft(9)), { floor: "floor-oak-natural", walls: { all: "paint-accessible-beige" } }, [
    { defId: "sofa", x: 0, z: ft(2.8), deg: 180 },
    { defId: "rug-area", x: 0, z: ft(0.2), w: IN(108), d: IN(144) },
    { defId: "coffee-table", x: 0, z: ft(0.2) },
    { defId: "armchair", x: -ft(4.4), z: ft(0.4), deg: 120 },
    { defId: "side-table", x: ft(4), z: ft(2.8) },
    { defId: "table-lamp", x: ft(4), z: ft(2.8), y: IN(22) },
    { defId: "tv-console", x: 0, z: -L / 2 + IN(9) },
    { defId: "fireplace", x: -W / 2 + IN(9), z: 0, deg: 90 },
    { defId: "bookshelf", x: W / 2 - IN(7), z: -ft(3), deg: -90 },
    { defId: "floor-lamp", x: -ft(4.5), z: ft(3.5) },
    { defId: "plant-large", x: ft(6.4), z: -ft(5.5) },
    { defId: "window-picture", x: ft(3), z: -L / 2 },
    { defId: "window-single", x: -W / 2, z: -ft(3.5), deg: 90 },
    { defId: "art-frame", x: 0, z: L / 2, deg: 180, w: IN(48) },
    { defId: "recessed", x: -ft(3.5), z: -ft(2) },
    { defId: "recessed", x: ft(3.5), z: -ft(2) },
    { defId: "recessed", x: -ft(3.5), z: ft(2.5) },
    { defId: "recessed", x: ft(3.5), z: ft(2.5) },
    { defId: "doorway-open", x: W / 2, z: ft(3.5), deg: -90, w: IN(60) },
  ]);
}

function bedroom(): DesignDoc {
  const W = ft(13);
  const L = ft(12);
  return doc(makeRectRoom(W, L, ft(9)), { floor: "floor-lvp-coastal", walls: { all: "paint-evergreen-fog" } }, [
    { defId: "bed-queen", x: 0, z: -L / 2 + IN(45) },
    { defId: "nightstand", x: -ft(3.4), z: -L / 2 + IN(14) },
    { defId: "nightstand", x: ft(3.4), z: -L / 2 + IN(14) },
    { defId: "table-lamp", x: -ft(3.4), z: -L / 2 + IN(14), y: IN(24) },
    { defId: "table-lamp", x: ft(3.4), z: -L / 2 + IN(14), y: IN(24) },
    { defId: "rug-area", x: 0, z: ft(0.5), w: IN(96), d: IN(120) },
    { defId: "dresser", x: -W / 2 + IN(10), z: ft(2), deg: 90 },
    { defId: "mirror-round", x: -W / 2, z: ft(2), deg: 90 },
    { defId: "armchair", x: ft(4.4), z: ft(3.6), deg: -135 },
    { defId: "flush-mount", x: 0, z: 0 },
    { defId: "window-double", x: 0, z: L / 2, deg: 180 },
    { defId: "window-single", x: W / 2, z: -ft(1), deg: -90 },
    { defId: "plant-large", x: W / 2 - IN(13), z: -L / 2 + IN(13) },
    { defId: "door-single", x: -W / 2 + IN(24), z: L / 2, deg: 180 },
  ]);
}

function laundry(): DesignDoc {
  const W = ft(8);
  const L = ft(6);
  return doc(makeRectRoom(W, L, ft(8)), { floor: "floor-tile-porcelain", walls: { all: "paint-sea-salt-blue" } }, [
    { defId: "washer", x: -IN(15), z: -L / 2 + IN(16) },
    { defId: "dryer", x: IN(15), z: -L / 2 + IN(16) },
    { defId: "wall-cab", x: 0, z: -L / 2 + IN(6.5), w: IN(48) },
    { defId: "open-shelves", x: W / 2 - IN(6), z: -ft(0.5), deg: -90, w: IN(30) },
    { defId: "base-sink", x: -W / 2 + IN(13), z: -L / 2 + IN(13), w: IN(24) },
    { defId: "flush-mount", x: 0, z: ft(0.5) },
    { defId: "door-single", x: 0, z: L / 2 },
  ]);
}

function lShapeGreatRoom(): DesignDoc {
  const W = ft(20);
  const L = ft(16);
  return doc(
    makeLShapeRoom(W, L, ft(8), ft(6), ft(10)),
    { floor: "floor-oak-natural", walls: { all: "paint-soft-chalk" } },
    [
      // kitchen zone in the north-west
      { defId: "base-corner", x: -W / 2 + IN(18), z: -L / 2 + IN(18) },
      { defId: "base-sink", x: -W / 2 + IN(60), z: -L / 2 + IN(12.5), w: IN(36) },
      { defId: "dishwasher", x: -W / 2 + IN(90), z: -L / 2 + IN(12.5) },
      { defId: "range-30", x: -W / 2 + IN(117), z: -L / 2 + IN(12.5) },
      { defId: "range-hood", x: -W / 2 + IN(117), z: -L / 2 + IN(10) },
      { defId: "wall-cab", x: -W / 2 + IN(60), z: -L / 2 + IN(6.5) },
      { defId: "fridge-french", x: -W / 2 + IN(16), z: -L / 2 + IN(50), deg: 90 },
      { defId: "island-seating", x: -ft(3), z: -ft(2), w: IN(72) },
      { defId: "island-pendants", x: -ft(3), z: -ft(2), w: IN(48) },
      { defId: "counter-stool", x: -ft(4.2), z: -ft(0.4), deg: 180 },
      { defId: "counter-stool", x: -ft(2.2), z: -ft(0.4), deg: 180 },
      // living zone south
      { defId: "rug-area", x: -ft(3), z: ft(4.8), w: IN(108), d: IN(96) },
      { defId: "sofa", x: -ft(3), z: ft(6.6), deg: 180 },
      { defId: "coffee-table", x: -ft(3), z: ft(4.4) },
      { defId: "tv-console", x: -ft(3), z: ft(2.2) },
      { defId: "floor-lamp", x: -ft(7), z: ft(6.8) },
      { defId: "plant-large", x: ft(0.6), z: ft(6.8) },
      { defId: "window-picture", x: -ft(2), z: -L / 2, w: IN(84) },
      { defId: "door-sliding-glass", x: -W / 2, z: ft(4.5), deg: 90 },
      { defId: "doorway-open", x: W / 2, z: ft(0.5), deg: -90, w: IN(48) },
      { defId: "recessed", x: -ft(6), z: -ft(4) },
      { defId: "recessed", x: 0, z: -ft(4) },
      { defId: "recessed", x: -ft(6), z: ft(2) },
      { defId: "recessed", x: 0, z: ft(2) },
    ],
  );
}

export const ROOM_TEMPLATES: Record<string, RoomTemplate> = {
  "kitchen_galley": { key: "kitchen_galley", label: "Galley Kitchen", roomType: "kitchen", widthFt: 8, lengthFt: 12, description: "Two parallel runs, efficient workflow", build: kitchenGalley },
  "kitchen_l": { key: "kitchen_l", label: "L-Shape Kitchen", roomType: "kitchen", widthFt: 12, lengthFt: 10, description: "L-run with corner cabinet, sink, and stove", build: kitchenLShape },
  "kitchen_u": { key: "kitchen_u", label: "U-Shape Kitchen", roomType: "kitchen", widthFt: 12, lengthFt: 12, description: "Three walls of cabinets", build: kitchenUShape },
  "kitchen_island": { key: "kitchen_island", label: "Island Kitchen", roomType: "kitchen", widthFt: 14, lengthFt: 16, description: "Pro range, oven tower, seated island", build: kitchenIsland },
  "great_room": { key: "great_room", label: "Open Kitchen + Living", roomType: "kitchen", widthFt: 20, lengthFt: 16, description: "L-shaped great room: kitchen, island, and living zone", build: lShapeGreatRoom },
  "bath_master": { key: "bath_master", label: "Master Bathroom", roomType: "bathroom", widthFt: 10, lengthFt: 12, description: "Double vanity, freestanding tub, glass shower", build: bathMaster },
  "bath_guest": { key: "bath_guest", label: "Guest Bathroom", roomType: "bathroom", widthFt: 8, lengthFt: 8, description: "Vanity, alcove tub, toilet", build: bathGuest },
  "bath_half": { key: "bath_half", label: "Half Bath", roomType: "bathroom", widthFt: 5, lengthFt: 8, description: "Pedestal sink and toilet, moody navy", build: bathHalf },
  "living_room": { key: "living_room", label: "Living Room", roomType: "other", widthFt: 16, lengthFt: 14, description: "Sofa, fireplace, media wall", build: livingRoom },
  "bedroom_queen": { key: "bedroom_queen", label: "Bedroom", roomType: "bedroom", widthFt: 13, lengthFt: 12, description: "Queen bed, dresser, reading chair", build: bedroom },
  "laundry": { key: "laundry", label: "Laundry Room", roomType: "laundry", widthFt: 8, lengthFt: 6, description: "Side-by-side machines, sink, storage", build: laundry },
};

export type TemplateKey = keyof typeof ROOM_TEMPLATES;

// Legacy template keys (old room-designer) -> studio keys, so older clients
// and any saved links keep working.
const LEGACY_TEMPLATE_KEYS: Record<string, string> = {
  "kitchen-galley": "kitchen_galley",
  "kitchen-l-shape": "kitchen_l",
  "kitchen-u-shape": "kitchen_u",
  "kitchen-island": "kitchen_island",
  "bath-master": "bath_master",
  "bath-guest": "bath_guest",
  "bath-half": "bath_half",
  "galley": "kitchen_galley",
  "l_shape": "kitchen_l",
  "u_shape": "kitchen_u",
  "island": "kitchen_island",
  "master_bath": "bath_master",
  "guest_bath": "bath_guest",
  "half_bath": "bath_half",
};

export function resolveTemplate(key: string | undefined | null): RoomTemplate | null {
  if (!key) return null;
  return ROOM_TEMPLATES[key] ?? ROOM_TEMPLATES[LEGACY_TEMPLATE_KEYS[key] ?? ""] ?? null;
}
