// Room Studio - seeded object catalog.
//
// Every item renders procedurally from a `mesh` descriptor (see
// components/studio/canvas/builders.tsx). Dimensions are meters; UI shows
// feet/inches. Standard US millwork sizes throughout.

import { inches } from "./units";

export type Category =
  | "cabinets"
  | "appliances"
  | "fixtures"
  | "lighting"
  | "doors-windows"
  | "furniture"
  | "decor";

export type MountType = "floor" | "wall" | "ceiling" | "counter";

export interface CatalogItem {
  id: string;
  name: string;
  category: Category;
  /** Builder key - one procedural mesh recipe per kind. */
  mesh: string;
  /** Default footprint, meters. w = along wall (X before rotation), d = depth, h = height. */
  w: number;
  d: number;
  h: number;
  mount: MountType;
  /** Default elevation of the item's BOTTOM above the floor (wall/counter mounts). */
  elevation?: number;
  /** Width is user-adjustable between [min,max] (cabinet runs, counters, rugs...). */
  resizable?: { min: number; max: number; step?: number; axis?: "w" | "wd" };
  /** Finish slots this item exposes, with default finish ids. */
  finishes?: Record<string, string>;
  /** Item snaps back-against walls when dropped near one. */
  wallSnap?: boolean;
  /** Search keywords. */
  tags?: string[];
  /** Emits light when "lights on". */
  emitsLight?: boolean;
}

const IN = inches;

function def(item: CatalogItem): CatalogItem {
  return item;
}

// -------------------------------- Cabinets --------------------------------
// Base cabinets: 34.5" tall x 24" deep. Wall cabinets: 12" deep, bottom at 54".
// Tall cabinets: 84-96" tall x 24" deep.

const BASE_H = IN(34.5);
const BASE_D = IN(24);
const WALL_D = IN(12);
const WALL_ELEV = IN(54);

const cabinetFinishes = { cabinet: "cab-white", counter: "counter-quartz-white", hardware: "metal-brushed-nickel" };

export const CABINETS: CatalogItem[] = [
  def({ id: "base-door", name: "Base Cabinet", category: "cabinets", mesh: "cabinet-base", w: IN(24), d: BASE_D, h: BASE_H, mount: "floor", wallSnap: true, resizable: { min: IN(9), max: IN(48), step: IN(3) }, finishes: { ...cabinetFinishes }, tags: ["base", "door", "kitchen", "lower"] }),
  def({ id: "base-drawers", name: "Drawer Base", category: "cabinets", mesh: "cabinet-drawers", w: IN(24), d: BASE_D, h: BASE_H, mount: "floor", wallSnap: true, resizable: { min: IN(12), max: IN(42), step: IN(3) }, finishes: { ...cabinetFinishes }, tags: ["drawers", "base", "kitchen"] }),
  def({ id: "base-sink", name: "Sink Base", category: "cabinets", mesh: "cabinet-sink", w: IN(36), d: BASE_D, h: BASE_H, mount: "floor", wallSnap: true, resizable: { min: IN(24), max: IN(48), step: IN(3) }, finishes: { ...cabinetFinishes, sink: "metal-stainless", faucet: "metal-brushed-nickel" }, tags: ["sink", "kitchen", "farmhouse"] }),
  def({ id: "base-corner", name: "Corner Base (Lazy Susan)", category: "cabinets", mesh: "cabinet-corner", w: IN(36), d: IN(36), h: BASE_H, mount: "floor", wallSnap: true, finishes: { ...cabinetFinishes }, tags: ["corner", "lazy susan"] }),
  def({ id: "base-cooktop", name: "Cooktop Base", category: "cabinets", mesh: "cabinet-cooktop", w: IN(30), d: BASE_D, h: BASE_H, mount: "floor", wallSnap: true, resizable: { min: IN(30), max: IN(36), step: IN(6) }, finishes: { ...cabinetFinishes, metal: "metal-black-stainless" }, tags: ["cooktop", "stove"] }),
  def({ id: "island", name: "Kitchen Island", category: "cabinets", mesh: "island", w: IN(60), d: IN(36), h: IN(36), mount: "floor", resizable: { min: IN(36), max: IN(120), step: IN(6) }, finishes: { cabinet: "cab-navy", counter: "counter-quartz-calacatta", hardware: "metal-brass" }, tags: ["island", "kitchen", "seating"] }),
  def({ id: "island-seating", name: "Island with Seating", category: "cabinets", mesh: "island-overhang", w: IN(72), d: IN(42), h: IN(36), mount: "floor", resizable: { min: IN(48), max: IN(120), step: IN(6) }, finishes: { cabinet: "cab-navy", counter: "counter-quartz-calacatta", hardware: "metal-brass" }, tags: ["island", "breakfast bar", "overhang"] }),
  def({ id: "wall-cab", name: "Wall Cabinet", category: "cabinets", mesh: "cabinet-wall", w: IN(30), d: WALL_D, h: IN(30), mount: "wall", elevation: WALL_ELEV, wallSnap: true, resizable: { min: IN(9), max: IN(48), step: IN(3) }, finishes: { ...cabinetFinishes }, tags: ["wall", "upper", "kitchen"] }),
  def({ id: "wall-cab-tall", name: "Wall Cabinet 42\"", category: "cabinets", mesh: "cabinet-wall", w: IN(30), d: WALL_D, h: IN(42), mount: "wall", elevation: IN(54), wallSnap: true, resizable: { min: IN(9), max: IN(48), step: IN(3) }, finishes: { ...cabinetFinishes }, tags: ["wall", "upper", "tall"] }),
  def({ id: "wall-cab-glass", name: "Glass Wall Cabinet", category: "cabinets", mesh: "cabinet-wall-glass", w: IN(30), d: WALL_D, h: IN(30), mount: "wall", elevation: WALL_ELEV, wallSnap: true, resizable: { min: IN(12), max: IN(42), step: IN(3) }, finishes: { ...cabinetFinishes }, tags: ["glass", "display"] }),
  def({ id: "open-shelves", name: "Open Shelving", category: "cabinets", mesh: "open-shelves", w: IN(30), d: IN(10), h: IN(24), mount: "wall", elevation: IN(56), wallSnap: true, resizable: { min: IN(18), max: IN(60), step: IN(6) }, finishes: { wood: "wood-oak", hardware: "metal-matte-black" }, tags: ["shelf", "floating", "open"] }),
  def({ id: "pantry-tall", name: "Tall Pantry", category: "cabinets", mesh: "cabinet-tall", w: IN(24), d: BASE_D, h: IN(90), mount: "floor", wallSnap: true, resizable: { min: IN(18), max: IN(36), step: IN(3) }, finishes: { ...cabinetFinishes }, tags: ["pantry", "tall", "storage"] }),
  def({ id: "oven-tower", name: "Oven Tower", category: "cabinets", mesh: "cabinet-oven-tower", w: IN(30), d: BASE_D, h: IN(90), mount: "floor", wallSnap: true, finishes: { ...cabinetFinishes, metal: "metal-stainless" }, tags: ["wall oven", "tower", "tall"] }),
  def({ id: "vanity-36", name: "Bath Vanity", category: "cabinets", mesh: "vanity", w: IN(36), d: IN(21), h: IN(34), mount: "floor", wallSnap: true, resizable: { min: IN(24), max: IN(72), step: IN(6) }, finishes: { cabinet: "cab-greige", counter: "counter-marble-carrara", hardware: "metal-matte-black", sink: "metal-chrome" }, tags: ["bathroom", "vanity", "sink"] }),
  def({ id: "vanity-double", name: "Double Vanity", category: "cabinets", mesh: "vanity-double", w: IN(60), d: IN(21), h: IN(34), mount: "floor", wallSnap: true, resizable: { min: IN(48), max: IN(84), step: IN(6) }, finishes: { cabinet: "cab-navy", counter: "counter-quartz-white", hardware: "metal-brass", sink: "metal-chrome" }, tags: ["bathroom", "double", "vanity"] }),
];

// ------------------------------- Appliances -------------------------------

export const APPLIANCES: CatalogItem[] = [
  def({ id: "fridge-french", name: "French-Door Fridge", category: "appliances", mesh: "fridge-french", w: IN(36), d: IN(30), h: IN(70), mount: "floor", wallSnap: true, finishes: { metal: "metal-stainless" }, tags: ["refrigerator", "fridge"] }),
  def({ id: "fridge-side", name: "Side-by-Side Fridge", category: "appliances", mesh: "fridge-side", w: IN(36), d: IN(30), h: IN(70), mount: "floor", wallSnap: true, finishes: { metal: "metal-stainless" }, tags: ["refrigerator", "fridge"] }),
  def({ id: "range-30", name: "Range 30\"", category: "appliances", mesh: "range", w: IN(30), d: IN(26), h: IN(36), mount: "floor", wallSnap: true, finishes: { metal: "metal-stainless" }, tags: ["stove", "oven", "range"] }),
  def({ id: "range-36-pro", name: "Pro Range 36\"", category: "appliances", mesh: "range-pro", w: IN(36), d: IN(27), h: IN(36), mount: "floor", wallSnap: true, finishes: { metal: "metal-stainless" }, tags: ["stove", "professional", "range"] }),
  def({ id: "range-hood", name: "Range Hood", category: "appliances", mesh: "hood", w: IN(36), d: IN(20), h: IN(30), mount: "wall", elevation: IN(66), wallSnap: true, finishes: { metal: "metal-stainless" }, tags: ["hood", "vent"] }),
  def({ id: "dishwasher", name: "Dishwasher", category: "appliances", mesh: "dishwasher", w: IN(24), d: BASE_D, h: BASE_H, mount: "floor", wallSnap: true, finishes: { metal: "metal-stainless" }, tags: ["dishwasher"] }),
  def({ id: "microwave-otr", name: "OTR Microwave", category: "appliances", mesh: "microwave", w: IN(30), d: IN(16), h: IN(17), mount: "wall", elevation: IN(54), wallSnap: true, finishes: { metal: "metal-stainless" }, tags: ["microwave"] }),
  def({ id: "wine-fridge", name: "Wine Fridge", category: "appliances", mesh: "wine-fridge", w: IN(24), d: BASE_D, h: BASE_H, mount: "floor", wallSnap: true, finishes: { metal: "metal-black-stainless" }, tags: ["wine", "beverage"] }),
  def({ id: "washer", name: "Washer", category: "appliances", mesh: "washer", w: IN(27), d: IN(30), h: IN(38), mount: "floor", wallSnap: true, finishes: { metal: "metal-stainless" }, tags: ["laundry", "washer"] }),
  def({ id: "dryer", name: "Dryer", category: "appliances", mesh: "dryer", w: IN(27), d: IN(30), h: IN(38), mount: "floor", wallSnap: true, finishes: { metal: "metal-stainless" }, tags: ["laundry", "dryer"] }),
];

// -------------------------------- Fixtures --------------------------------

export const FIXTURES: CatalogItem[] = [
  def({ id: "sink-farmhouse", name: "Farmhouse Sink", category: "fixtures", mesh: "sink-farmhouse", w: IN(33), d: IN(20), h: IN(10), mount: "counter", elevation: BASE_H - IN(8), finishes: { basin: "cab-white", faucet: "metal-brushed-nickel" }, tags: ["sink", "apron", "kitchen"] }),
  def({ id: "toilet", name: "Toilet", category: "fixtures", mesh: "toilet", w: IN(16), d: IN(28), h: IN(30), mount: "floor", wallSnap: true, tags: ["bathroom", "toilet"] }),
  def({ id: "tub-freestanding", name: "Freestanding Tub", category: "fixtures", mesh: "tub", w: IN(60), d: IN(30), h: IN(23), mount: "floor", finishes: { faucet: "metal-matte-black" }, tags: ["bathtub", "tub", "soaking"] }),
  def({ id: "tub-alcove", name: "Alcove Tub", category: "fixtures", mesh: "tub-alcove", w: IN(60), d: IN(32), h: IN(20), mount: "floor", wallSnap: true, finishes: { faucet: "metal-chrome" }, tags: ["bathtub", "alcove"] }),
  def({ id: "shower-glass", name: "Glass Shower", category: "fixtures", mesh: "shower", w: IN(48), d: IN(36), h: IN(84), mount: "floor", wallSnap: true, resizable: { min: IN(32), max: IN(72), step: IN(4) }, finishes: { metal: "metal-matte-black", tile: "tile-white-subway" }, tags: ["shower", "glass", "walk-in"] }),
  def({ id: "pedestal-sink", name: "Pedestal Sink", category: "fixtures", mesh: "pedestal-sink", w: IN(24), d: IN(20), h: IN(34), mount: "floor", wallSnap: true, finishes: { faucet: "metal-chrome" }, tags: ["bathroom", "sink"] }),
  def({ id: "fireplace", name: "Fireplace", category: "fixtures", mesh: "fireplace", w: IN(60), d: IN(16), h: IN(48), mount: "floor", wallSnap: true, resizable: { min: IN(42), max: IN(84), step: IN(6) }, finishes: { surround: "tile-marble-herringbone", mantel: "wood-oak" }, emitsLight: true, tags: ["fireplace", "living", "mantel"] }),
  def({ id: "shower-niche", name: "Shower Niche", category: "fixtures", mesh: "shower-niche", w: IN(24), d: IN(3.5), h: IN(14), mount: "wall", elevation: IN(42), wallSnap: true, resizable: { min: IN(12), max: IN(60), step: IN(2) }, finishes: { tile: "tile-white-subway", trim: "metal-brushed-nickel" }, tags: ["niche", "shower", "shampoo", "recessed", "bathroom"] }),
  def({ id: "pony-wall", name: "Pony Wall", category: "fixtures", mesh: "pony-wall", w: IN(48), d: IN(5), h: IN(36), mount: "floor", resizable: { min: IN(18), max: IN(120), step: IN(2) }, finishes: { paint: "paint-soft-chalk", cap: "wood-oak" }, tags: ["half wall", "knee wall", "pony", "divider", "stub"] }),
];

// -------------------------------- Lighting --------------------------------

export const LIGHTING: CatalogItem[] = [
  def({ id: "recessed", name: "Recessed Light", category: "lighting", mesh: "recessed", w: IN(6), d: IN(6), h: IN(1.5), mount: "ceiling", emitsLight: true, tags: ["can", "recessed", "downlight"] }),
  def({ id: "pendant", name: "Pendant", category: "lighting", mesh: "pendant", w: IN(10), d: IN(10), h: IN(16), mount: "ceiling", finishes: { metal: "metal-matte-black" }, emitsLight: true, tags: ["pendant", "hanging"] }),
  def({ id: "pendant-glass", name: "Glass Globe Pendant", category: "lighting", mesh: "pendant-glass", w: IN(10), d: IN(10), h: IN(14), mount: "ceiling", finishes: { metal: "metal-brass" }, emitsLight: true, tags: ["globe", "pendant"] }),
  def({ id: "island-pendants", name: "Island Pendant Trio", category: "lighting", mesh: "pendant-trio", w: IN(48), d: IN(10), h: IN(18), mount: "ceiling", resizable: { min: IN(30), max: IN(84), step: IN(6) }, finishes: { metal: "metal-matte-black" }, emitsLight: true, tags: ["island", "trio", "pendants"] }),
  def({ id: "chandelier", name: "Chandelier", category: "lighting", mesh: "chandelier", w: IN(28), d: IN(28), h: IN(24), mount: "ceiling", finishes: { metal: "metal-brass" }, emitsLight: true, tags: ["chandelier", "dining"] }),
  def({ id: "flush-mount", name: "Flush Mount", category: "lighting", mesh: "flush-mount", w: IN(14), d: IN(14), h: IN(6), mount: "ceiling", finishes: { metal: "metal-brushed-nickel" }, emitsLight: true, tags: ["flush", "ceiling"] }),
  def({ id: "sconce", name: "Wall Sconce", category: "lighting", mesh: "sconce", w: IN(6), d: IN(8), h: IN(12), mount: "wall", elevation: IN(60), wallSnap: true, finishes: { metal: "metal-matte-black" }, emitsLight: true, tags: ["sconce", "wall"] }),
  def({ id: "floor-lamp", name: "Floor Lamp", category: "lighting", mesh: "floor-lamp", w: IN(16), d: IN(16), h: IN(62), mount: "floor", finishes: { metal: "metal-brass", shade: "fab-oat" }, emitsLight: true, tags: ["lamp", "floor"] }),
  def({ id: "table-lamp", name: "Table Lamp", category: "lighting", mesh: "table-lamp", w: IN(12), d: IN(12), h: IN(22), mount: "counter", elevation: 0, finishes: { metal: "metal-brass", shade: "fab-oat" }, emitsLight: true, tags: ["lamp", "table"] }),
  def({ id: "track-light", name: "Track Lighting", category: "lighting", mesh: "track", w: IN(48), d: IN(5), h: IN(8), mount: "ceiling", resizable: { min: IN(24), max: IN(96), step: IN(12) }, finishes: { metal: "metal-matte-black" }, emitsLight: true, tags: ["track"] }),
  def({ id: "under-cab-light", name: "Under-Cabinet Light", category: "lighting", mesh: "under-cab-light", w: IN(30), d: IN(2), h: IN(1.2), mount: "wall", elevation: IN(52.5), wallSnap: true, resizable: { min: IN(12), max: IN(48), step: IN(6) }, emitsLight: true, tags: ["under cabinet", "strip", "task", "led"] }),
];

// ----------------------------- Doors & Windows -----------------------------

export const DOORS_WINDOWS: CatalogItem[] = [
  def({ id: "door-single", name: "Door", category: "doors-windows", mesh: "door", w: IN(32), d: IN(2), h: IN(80), mount: "wall", elevation: 0, wallSnap: true, finishes: { door: "paint-pure-white", hardware: "metal-matte-black" }, tags: ["door", "interior"] }),
  def({ id: "door-double", name: "Double Door", category: "doors-windows", mesh: "door-double", w: IN(60), d: IN(2), h: IN(80), mount: "wall", elevation: 0, wallSnap: true, finishes: { door: "paint-pure-white", hardware: "metal-matte-black" }, tags: ["french", "double"] }),
  def({ id: "door-sliding-glass", name: "Sliding Glass Door", category: "doors-windows", mesh: "door-sliding", w: IN(72), d: IN(3), h: IN(80), mount: "wall", elevation: 0, wallSnap: true, finishes: { frame: "metal-matte-black" }, tags: ["slider", "patio", "glass"] }),
  def({ id: "doorway-open", name: "Open Doorway", category: "doors-windows", mesh: "doorway", w: IN(36), d: IN(2), h: IN(80), mount: "wall", elevation: 0, wallSnap: true, resizable: { min: IN(28), max: IN(96), step: IN(4) }, tags: ["opening", "cased", "archway"] }),
  def({ id: "window-single", name: "Window", category: "doors-windows", mesh: "window", w: IN(30), d: IN(2), h: IN(48), mount: "wall", elevation: IN(30), wallSnap: true, resizable: { min: IN(20), max: IN(48), step: IN(2) }, finishes: { frame: "paint-pure-white" }, tags: ["window", "single hung"] }),
  def({ id: "window-double", name: "Double Window", category: "doors-windows", mesh: "window-double", w: IN(60), d: IN(2), h: IN(48), mount: "wall", elevation: IN(30), wallSnap: true, resizable: { min: IN(40), max: IN(84), step: IN(4) }, finishes: { frame: "paint-pure-white" }, tags: ["window", "double"] }),
  def({ id: "window-picture", name: "Picture Window", category: "doors-windows", mesh: "window-picture", w: IN(72), d: IN(2), h: IN(54), mount: "wall", elevation: IN(24), wallSnap: true, resizable: { min: IN(48), max: IN(120), step: IN(6) }, finishes: { frame: "paint-tricorn-black" }, tags: ["picture", "large"] }),
  def({ id: "window-kitchen", name: "Kitchen Window", category: "doors-windows", mesh: "window", w: IN(36), d: IN(2), h: IN(36), mount: "wall", elevation: IN(42), wallSnap: true, resizable: { min: IN(24), max: IN(60), step: IN(2) }, finishes: { frame: "paint-pure-white" }, tags: ["window", "sink"] }),
];

// -------------------------------- Furniture --------------------------------

export const FURNITURE: CatalogItem[] = [
  def({ id: "sofa", name: "Sofa", category: "furniture", mesh: "sofa", w: IN(84), d: IN(38), h: IN(33), mount: "floor", finishes: { fabric: "fab-oat", legs: "wood-walnut" }, tags: ["couch", "living"] }),
  def({ id: "sofa-sectional", name: "Sectional", category: "furniture", mesh: "sectional", w: IN(110), d: IN(84), h: IN(33), mount: "floor", finishes: { fabric: "fab-cloud", legs: "wood-black" }, tags: ["sectional", "l-shape", "couch"] }),
  def({ id: "loveseat", name: "Loveseat", category: "furniture", mesh: "sofa", w: IN(60), d: IN(36), h: IN(33), mount: "floor", finishes: { fabric: "fab-slate-blue", legs: "wood-walnut" }, tags: ["loveseat"] }),
  def({ id: "armchair", name: "Armchair", category: "furniture", mesh: "armchair", w: IN(33), d: IN(34), h: IN(32), mount: "floor", finishes: { fabric: "fab-cognac", legs: "wood-walnut" }, tags: ["chair", "accent"] }),
  def({ id: "coffee-table", name: "Coffee Table", category: "furniture", mesh: "coffee-table", w: IN(48), d: IN(26), h: IN(17), mount: "floor", finishes: { wood: "wood-oak" }, tags: ["table", "living"] }),
  def({ id: "side-table", name: "Side Table", category: "furniture", mesh: "side-table", w: IN(20), d: IN(20), h: IN(22), mount: "floor", finishes: { wood: "wood-walnut" }, tags: ["end table"] }),
  def({ id: "tv-console", name: "TV Console + TV", category: "furniture", mesh: "tv-console", w: IN(70), d: IN(16), h: IN(22), mount: "floor", wallSnap: true, finishes: { wood: "wood-walnut" }, tags: ["media", "tv", "entertainment"] }),
  def({ id: "dining-table", name: "Dining Table", category: "furniture", mesh: "dining-table", w: IN(72), d: IN(38), h: IN(30), mount: "floor", resizable: { min: IN(48), max: IN(108), step: IN(6) }, finishes: { wood: "wood-oak" }, tags: ["dining", "table"] }),
  def({ id: "dining-chair", name: "Dining Chair", category: "furniture", mesh: "dining-chair", w: IN(19), d: IN(21), h: IN(34), mount: "floor", finishes: { wood: "wood-oak", fabric: "fab-oat" }, tags: ["chair", "dining"] }),
  def({ id: "counter-stool", name: "Counter Stool", category: "furniture", mesh: "stool", w: IN(17), d: IN(17), h: IN(26), mount: "floor", finishes: { wood: "wood-black", fabric: "fab-cognac" }, tags: ["stool", "bar", "island"] }),
  def({ id: "bookshelf", name: "Bookshelf", category: "furniture", mesh: "bookshelf", w: IN(36), d: IN(12), h: IN(72), mount: "floor", wallSnap: true, finishes: { wood: "wood-oak" }, tags: ["shelf", "storage"] }),
  def({ id: "bed-queen", name: "Queen Bed", category: "furniture", mesh: "bed", w: IN(62), d: IN(85), h: IN(48), mount: "floor", wallSnap: true, finishes: { fabric: "fab-oat", frame: "wood-walnut" }, tags: ["bed", "bedroom", "queen"] }),
  def({ id: "bed-king", name: "King Bed", category: "furniture", mesh: "bed", w: IN(78), d: IN(85), h: IN(48), mount: "floor", wallSnap: true, finishes: { fabric: "fab-cloud", frame: "wood-walnut" }, tags: ["bed", "king"] }),
  def({ id: "dresser", name: "Dresser", category: "furniture", mesh: "dresser", w: IN(58), d: IN(18), h: IN(32), mount: "floor", wallSnap: true, finishes: { wood: "wood-walnut", hardware: "metal-brass" }, tags: ["dresser", "bedroom"] }),
  def({ id: "nightstand", name: "Nightstand", category: "furniture", mesh: "nightstand", w: IN(22), d: IN(16), h: IN(24), mount: "floor", finishes: { wood: "wood-walnut", hardware: "metal-brass" }, tags: ["nightstand", "bedroom"] }),
  def({ id: "desk", name: "Desk", category: "furniture", mesh: "desk", w: IN(55), d: IN(24), h: IN(30), mount: "floor", finishes: { wood: "wood-oak", legs: "metal-matte-black" }, tags: ["desk", "office"] }),
  def({ id: "rug-area", name: "Area Rug", category: "furniture", mesh: "rug", w: IN(96), d: IN(120), h: IN(0.5), mount: "floor", resizable: { min: IN(48), max: IN(144), step: IN(12), axis: "wd" }, finishes: { fabric: "fab-cream-boucle" }, tags: ["rug", "carpet"] }),
];

// --------------------------------- Decor ---------------------------------

export const DECOR: CatalogItem[] = [
  def({ id: "plant-large", name: "Large Plant", category: "decor", mesh: "plant", w: IN(20), d: IN(20), h: IN(60), mount: "floor", tags: ["fiddle leaf", "plant"] }),
  def({ id: "plant-small", name: "Small Plant", category: "decor", mesh: "plant-small", w: IN(10), d: IN(10), h: IN(16), mount: "counter", elevation: 0, tags: ["plant", "pot"] }),
  def({ id: "mirror-round", name: "Round Mirror", category: "decor", mesh: "mirror", w: IN(30), d: IN(1.5), h: IN(30), mount: "wall", elevation: IN(48), wallSnap: true, finishes: { frame: "metal-brass" }, tags: ["mirror"] }),
  def({ id: "art-frame", name: "Wall Art", category: "decor", mesh: "art", w: IN(30), d: IN(1.5), h: IN(40), mount: "wall", elevation: IN(45), wallSnap: true, resizable: { min: IN(16), max: IN(60), step: IN(2) }, tags: ["art", "picture", "frame"] }),
  def({ id: "vase-counter", name: "Decor Vase", category: "decor", mesh: "vase", w: IN(7), d: IN(7), h: IN(13), mount: "counter", elevation: 0, tags: ["vase", "styling"] }),
];

export const CATALOG: CatalogItem[] = [
  ...CABINETS, ...APPLIANCES, ...FIXTURES, ...LIGHTING, ...DOORS_WINDOWS, ...FURNITURE, ...DECOR,
];

const CATALOG_MAP = new Map(CATALOG.map((c) => [c.id, c]));

export function getItemDef(defId: string): CatalogItem | undefined {
  return CATALOG_MAP.get(defId) ?? LEGACY_ASSET_MAP_RESOLVED.get(defId);
}

export const CATEGORY_LABELS: Record<Category, string> = {
  cabinets: "Cabinets",
  appliances: "Appliances",
  fixtures: "Fixtures",
  lighting: "Lighting",
  "doors-windows": "Doors & Windows",
  furniture: "Furniture",
  decor: "Decor",
};

export const CATEGORY_ORDER: Category[] = [
  "cabinets", "appliances", "fixtures", "lighting", "doors-windows", "furniture", "decor",
];

// Legacy v1 asset-registry ids → studio ids (best-effort upgrade of old rooms).
const LEGACY_ASSET_MAP: Record<string, string> = {
  "base-cabinet-24": "base-door",
  "base-cabinet-36": "base-door",
  "drawer-base": "base-drawers",
  "sink-base-36": "base-sink",
  "corner-cabinet": "base-corner",
  "wall-cabinet-30": "wall-cab",
  "glass-door-cabinet": "wall-cab-glass",
  "island-48": "island",
  "fridge-french-door": "fridge-french",
  "wall-oven": "oven-tower",
  "over-range-microwave": "microwave-otr",
  "farmhouse-sink": "sink-farmhouse",
  "toilet-standard": "toilet",
  "toilet-elongated": "toilet",
  "shower-enclosure": "shower-glass",
  "door-sliding": "door-sliding-glass",
  "window-single-hung": "window-single",
  "window-double-hung": "window-double",
  "window-casement": "window-single",
  "ceiling-light-1": "flush-mount",
  "ceiling-light-2": "flush-mount",
  "houseplant-large": "plant-large",
  "houseplant-medium": "plant-large",
  "houseplant-small": "plant-small",
};

const LEGACY_ASSET_MAP_RESOLVED = new Map(
  Object.entries(LEGACY_ASSET_MAP)
    .map(([legacy, modern]) => [legacy, CATALOG_MAP.get(modern)!] as const)
    .filter(([, v]) => !!v),
);
