// Room Studio — seeded finish library.
//
// Everything renders procedurally (color + roughness/metalness), no texture
// downloads — the studio must work offline and load instantly. Hex values are
// tuned to read well under the studio's neutral lighting rig.

export type FinishKind = "paint" | "floor" | "counter" | "cabinet" | "metal" | "fabric" | "wood" | "tile";

export interface Finish {
  id: string;
  name: string;
  kind: FinishKind;
  hex: string;
  roughness?: number; // default .9 paint, .6 floor…
  metalness?: number;
  /** Secondary hex for two-tone looks (e.g. butcher block stripes). Unused by flat materials. */
  accentHex?: string;
}

// ─────────────────────────── Wall paint (48 colors) ───────────────────────────
// Curated interior palette: whites → greiges → warm neutrals → blues/greens →
// bolds. Names are our own; hexes chosen to match popular designer tones.

const P = (id: string, name: string, hex: string): Finish => ({ id, name, kind: "paint", hex, roughness: 0.94 });

export const PAINTS: Finish[] = [
  // Whites & creams
  P("paint-pure-white", "Pure White", "#F4F4F0"),
  P("paint-soft-chalk", "Soft Chalk", "#F0EDE3"),
  P("paint-ivory-lace", "Ivory Lace", "#F3EDDD"),
  P("paint-swiss-coffee", "Swiss Coffee", "#EFE9D8"),
  P("paint-alabaster", "Alabaster", "#EDEAE0"),
  P("paint-linen-white", "Linen White", "#EFE8D6"),
  // Greiges & grays
  P("paint-agreeable-greige", "Warm Greige", "#D1CBC1"),
  P("paint-revere-mist", "Pewter Mist", "#CCC9BD"),
  P("paint-repose-gray", "Repose Gray", "#C9C6BE"),
  P("paint-classic-gray", "Classic Gray", "#D5D2C8"),
  P("paint-stonework", "Stonework", "#BBB6A9"),
  P("paint-anchor-gray", "Anchor Gray", "#8E8D87"),
  P("paint-iron-mountain", "Iron Mountain", "#56544E"),
  P("paint-graphite", "Graphite", "#3E3D3B"),
  // Warm neutrals & earth
  P("paint-accessible-beige", "Accessible Beige", "#D6CCBB"),
  P("paint-canvas-tan", "Canvas Tan", "#DCD2BD"),
  P("paint-kilim-beige", "Kilim Beige", "#D9C7AC"),
  P("paint-latte", "Latte", "#C2AD92"),
  P("paint-mushroom", "Mushroom", "#AFA493"),
  P("paint-terracotta", "Terracotta Clay", "#C07A5B"),
  P("paint-cavern-clay", "Cavern Clay", "#AC6B53"),
  P("paint-spiced-honey", "Spiced Honey", "#B98E61"),
  // Blues
  P("paint-sea-salt-blue", "Misty Harbor", "#C7D2CC"),
  P("paint-rainwashed", "Rainwashed", "#BFD1C8"),
  P("paint-upward-blue", "Upward Blue", "#A9BCC9"),
  P("paint-santorini", "Santorini", "#7FA6B8"),
  P("paint-slate-blue", "Slate Blue", "#5D7B8A"),
  P("paint-naval", "Naval", "#2E3A4C"),
  P("paint-hale-navy", "Hale Navy", "#39414F"),
  // Greens
  P("paint-sage-whisper", "Sage Whisper", "#C3C9B4"),
  P("paint-soft-fern", "Soft Fern", "#AEB89B"),
  P("paint-clary-sage", "Clary Sage", "#9AA386"),
  P("paint-evergreen-fog", "Evergreen Fog", "#95978A"),
  P("paint-rosemary", "Rosemary", "#64715E"),
  P("paint-pewter-green", "Pewter Green", "#5E6E63"),
  P("paint-hunter-green", "Hunter Green", "#3B4A3F"),
  P("paint-forest-night", "Forest Night", "#2C3A33"),
  // Bolds & moody
  P("paint-redend-point", "Rosy Sandstone", "#B5897C"),
  P("paint-sommelier", "Sommelier", "#6E3B43"),
  P("paint-merlot", "Merlot", "#5B2E35"),
  P("paint-aubergine", "Aubergine", "#4A3B4A"),
  P("paint-tricorn-black", "Tricorn Black", "#2F2F30"),
  // Sunny accents
  P("paint-golden-straw", "Golden Straw", "#D9B36A"),
  P("paint-honeycomb", "Honeycomb", "#C9963F"),
  P("paint-blush-petal", "Blush Petal", "#E3C5BB"),
  P("paint-coral-reef", "Coral Reef", "#D87E5E"),
  P("paint-sky-wash", "Sky Wash", "#CFE0E4"),
  P("paint-first-light", "First Light", "#EBD9D4"),
];

// Popular Sherwin-Williams colors for spec-matching real jobs. Names/numbers
// are SW's identifiers used for reference; hex values are close screen
// approximations (paint chips should always be confirmed physically).

export const SW_PAINTS: Finish[] = [
  P("sw-7008", "SW 7008 Alabaster", "#EDEAE0"),
  P("sw-7757", "SW 7757 High Reflective White", "#F7F7F1"),
  P("sw-7005", "SW 7005 Pure White", "#EFEDE6"),
  P("sw-7042", "SW 7042 Shoji White", "#E6E0D2"),
  P("sw-7012", "SW 7012 Creamy", "#F1EADC"),
  P("sw-7551", "SW 7551 Greek Villa", "#F0EADC"),
  P("sw-7029", "SW 7029 Agreeable Gray", "#D1CBC1"),
  P("sw-7015", "SW 7015 Repose Gray", "#C9C5BD"),
  P("sw-7641", "SW 7641 Colonnade Gray", "#C5C0B5"),
  P("sw-7043", "SW 7043 Worldly Gray", "#CCC5B8"),
  P("sw-7036", "SW 7036 Accessible Beige", "#D1C7B8"),
  P("sw-7050", "SW 7050 Useful Gray", "#CFC9BC"),
  P("sw-7016", "SW 7016 Mindful Gray", "#BCB6AB"),
  P("sw-7017", "SW 7017 Dorian Gray", "#ACA79C"),
  P("sw-7019", "SW 7019 Gauntlet Gray", "#79756C"),
  P("sw-7048", "SW 7048 Urbane Bronze", "#54504A"),
  P("sw-7069", "SW 7069 Iron Ore", "#434341"),
  P("sw-6258", "SW 6258 Tricorn Black", "#2F2F30"),
  P("sw-7006", "SW 7006 Extra White", "#EEEFEA"),
  P("sw-9130", "SW 9130 Evergreen Fog", "#95978A"),
  P("sw-6204", "SW 6204 Sea Salt", "#CDD2C4"),
  P("sw-6212", "SW 6212 Quietude", "#ADBBB2"),
  P("sw-6244", "SW 6244 Naval", "#2F3D4C"),
  P("sw-9178", "SW 9178 In the Navy", "#30394A"),
  P("sw-9176", "SW 9176 Dress Blues", "#3D4D60"),
  P("sw-6221", "SW 6221 Moody Blue", "#7E909A"),
  P("sw-9151", "SW 9151 Daphne", "#A7BCC7"),
  P("sw-6219", "SW 6219 Rain", "#B6C5C4"),
  P("sw-6478", "SW 6478 Watery", "#B3CCC9"),
  P("sw-7602", "SW 7602 Indigo Batik", "#41546B"),
  P("sw-6991", "SW 6991 Black Magic", "#323233"),
  P("sw-7675", "SW 7675 Sealskin", "#4A443D"),
  P("sw-6090", "SW 6090 Java", "#6A5546"),
  P("sw-9092", "SW 9092 Iced Mocha", "#B3997F"),
  P("sw-6106", "SW 6106 Kilim Beige", "#D9C7AC"),
  P("sw-7531", "SW 7531 Canvas Tan", "#DCD2BD"),
  P("sw-6148", "SW 6148 Wool Skein", "#D8CDB4"),
  P("sw-9109", "SW 9109 Natural Linen", "#DFD4BE"),
  P("sw-6172", "SW 6172 Hardware", "#8B8579"),
  P("sw-6199", "SW 6199 Rare Gray", "#B6B5A9"),
  P("sw-7735", "SW 7735 Palm Leaf", "#7A7B62"),
  P("sw-6188", "SW 6188 Shade-Grown", "#4C5448"),
  P("sw-2847", "SW 2847 Roycroft Bottle Green", "#324038"),
  P("sw-6041", "SW 6041 Otter", "#7A6A5D"),
  P("sw-6385", "SW 6385 Dover White", "#F0E8D4"),
  P("sw-6840", "SW 6840 Exuberant Pink", "#B55C74"),
  P("sw-6321", "SW 6321 Red Bay", "#8E4A3F"),
  P("sw-7589", "SW 7589 Habanero Chile", "#B65540"),
];

// ─────────────────────────── Flooring (16) ───────────────────────────

const F = (id: string, name: string, hex: string, roughness = 0.62, accentHex?: string): Finish =>
  ({ id, name, kind: "floor", hex, roughness, accentHex });

export const FLOORS: Finish[] = [
  F("floor-oak-natural", "Natural Oak", "#C8A878", 0.6, "#B9986A"),
  F("floor-oak-white", "White Oak", "#D8C5A6", 0.6, "#CDB997"),
  F("floor-oak-honey", "Honey Oak", "#BE9159", 0.6, "#B08350"),
  F("floor-walnut", "Walnut", "#6B4F39", 0.55, "#5E4430"),
  F("floor-walnut-dark", "Dark Walnut", "#4E3826", 0.55, "#43301F"),
  F("floor-espresso", "Espresso", "#3A2C22", 0.55, "#322419"),
  F("floor-gray-wash", "Gray Wash", "#A99F92", 0.65, "#9C9285"),
  F("floor-driftwood", "Driftwood", "#8D8273", 0.65, "#81786A"),
  F("floor-maple", "Maple", "#E0C9A2", 0.6, "#D6BD93"),
  F("floor-hickory", "Hickory", "#A97C4F", 0.6, "#9A6E43"),
  F("floor-tile-porcelain", "Porcelain Tile", "#D9D6CE", 0.35, "#CFCCC4"),
  F("floor-tile-slate", "Slate Tile", "#5C5F62", 0.5, "#54575A"),
  F("floor-tile-travertine", "Travertine", "#CFC0A5", 0.45, "#C5B699"),
  F("floor-tile-marble", "Marble Tile", "#E6E4DF", 0.25, "#DBD9D3"),
  F("floor-concrete", "Polished Concrete", "#9D9B96", 0.4),
  F("floor-lvp-coastal", "Coastal LVP", "#C9B795", 0.58, "#BFAD8A"),
];

// ─────────────────────────── Countertops (10) ───────────────────────────

const C = (id: string, name: string, hex: string, roughness: number, accentHex?: string): Finish =>
  ({ id, name, kind: "counter", hex, roughness, accentHex });

export const COUNTERS: Finish[] = [
  C("counter-quartz-white", "White Quartz", "#EDEBE4", 0.18),
  C("counter-quartz-calacatta", "Calacatta Quartz", "#E9E6DE", 0.15, "#C9C4B6"),
  C("counter-quartz-gray", "Storm Quartz", "#B9B7B0", 0.2),
  C("counter-granite-black", "Black Granite", "#23252A", 0.22, "#3A3D45"),
  C("counter-granite-santa-cecilia", "Santa Cecilia Granite", "#C8A773", 0.3, "#A37F50"),
  C("counter-marble-carrara", "Carrara Marble", "#E3E2DE", 0.12, "#BFC2C4"),
  C("counter-butcher-block", "Butcher Block", "#B98E5C", 0.5, "#A87E4E"),
  C("counter-soapstone", "Soapstone", "#3E444A", 0.45),
  C("counter-concrete", "Concrete", "#8E8C87", 0.5),
  C("counter-laminate-white", "White Laminate", "#E8E6E0", 0.4),
];

// ─────────────────────────── Cabinet finishes (14) ───────────────────────────

const K = (id: string, name: string, hex: string, roughness = 0.55): Finish =>
  ({ id, name, kind: "cabinet", hex, roughness });

export const CABINET_FINISHES: Finish[] = [
  K("cab-white", "Classic White", "#EDEAE2"),
  K("cab-cream", "Antique Cream", "#E6DECB"),
  K("cab-greige", "Greige", "#BBB2A4"),
  K("cab-light-gray", "Dove Gray", "#AFB0AC"),
  K("cab-charcoal", "Charcoal", "#494B4D"),
  K("cab-black", "Matte Black", "#2B2B2C", 0.65),
  K("cab-navy", "Naval Blue", "#32405A"),
  K("cab-slate-blue", "Slate Blue", "#5A7287"),
  K("cab-sage", "Sage Green", "#8B987F"),
  K("cab-hunter", "Hunter Green", "#3E4F43"),
  K("cab-oak", "Natural Oak", "#C19A64", 0.5),
  K("cab-walnut", "Walnut", "#6A4D36", 0.45),
  K("cab-honey", "Honey Stain", "#A87B49", 0.5),
  K("cab-espresso", "Espresso", "#41312A", 0.45),
];

// ─────────────────────────── Metals / hardware (6) ───────────────────────────

const Mt = (id: string, name: string, hex: string, roughness: number, metalness: number): Finish =>
  ({ id, name, kind: "metal", hex, roughness, metalness });

export const METALS: Finish[] = [
  Mt("metal-stainless", "Stainless", "#C6CACD", 0.32, 0.6),
  Mt("metal-black-stainless", "Black Stainless", "#4A4F54", 0.38, 0.55),
  Mt("metal-brushed-nickel", "Brushed Nickel", "#B3B4AF", 0.42, 0.6),
  Mt("metal-matte-black", "Matte Black", "#2B2C2E", 0.7, 0.3),
  Mt("metal-brass", "Brushed Brass", "#C8A95F", 0.38, 0.65),
  Mt("metal-chrome", "Chrome", "#D2D6DA", 0.14, 0.85),
  Mt("metal-bronze", "Oil-Rubbed Bronze", "#52423A", 0.5, 0.5),
];

// ─────────────────────────── Fabrics / woods for furniture ───────────────────────────

export const FABRICS: Finish[] = [
  { id: "fab-oat", name: "Oat Linen", kind: "fabric", hex: "#D4CBB8", roughness: 1 },
  { id: "fab-cloud", name: "Cloud Gray", kind: "fabric", hex: "#BFBFBC", roughness: 1 },
  { id: "fab-charcoal", name: "Charcoal", kind: "fabric", hex: "#54565A", roughness: 1 },
  { id: "fab-slate-blue", name: "Slate Blue", kind: "fabric", hex: "#6B7E8F", roughness: 1 },
  { id: "fab-olive", name: "Olive", kind: "fabric", hex: "#7A7A5C", roughness: 1 },
  { id: "fab-rust", name: "Rust", kind: "fabric", hex: "#A65B3F", roughness: 1 },
  { id: "fab-cognac", name: "Cognac Leather", kind: "fabric", hex: "#8E5A33", roughness: 0.6 },
  { id: "fab-saddle", name: "Saddle Leather", kind: "fabric", hex: "#6F4426", roughness: 0.6 },
  { id: "fab-cream-boucle", name: "Cream Bouclé", kind: "fabric", hex: "#E4DDCE", roughness: 1 },
];

export const WOODS: Finish[] = [
  { id: "wood-oak", name: "Oak", kind: "wood", hex: "#BD9667", roughness: 0.55 },
  { id: "wood-walnut", name: "Walnut", kind: "wood", hex: "#5F452F", roughness: 0.5 },
  { id: "wood-black", name: "Black Stain", kind: "wood", hex: "#2E2A26", roughness: 0.55 },
  { id: "wood-white", name: "White", kind: "wood", hex: "#E9E6DE", roughness: 0.55 },
];

export const TILES: Finish[] = [
  { id: "tile-white-subway", name: "White Subway", kind: "tile", hex: "#E9E7E1", roughness: 0.25 },
  { id: "tile-gray-subway", name: "Gray Subway", kind: "tile", hex: "#B9BCBA", roughness: 0.25 },
  { id: "tile-navy-gloss", name: "Navy Gloss", kind: "tile", hex: "#33455C", roughness: 0.2 },
  { id: "tile-sage-zellige", name: "Sage Zellige", kind: "tile", hex: "#A3AE97", roughness: 0.3 },
  { id: "tile-marble-herringbone", name: "Marble Herringbone", kind: "tile", hex: "#E2E0DA", roughness: 0.2 },
];

// ─────────────────────────── Lookup ───────────────────────────

export const ALL_FINISHES: Finish[] = [
  ...PAINTS, ...SW_PAINTS, ...FLOORS, ...COUNTERS, ...CABINET_FINISHES, ...METALS, ...FABRICS, ...WOODS, ...TILES,
];

const FINISH_MAP = new Map(ALL_FINISHES.map((f) => [f.id, f]));

// DB-backed library finishes (real vendor lines) register at runtime and
// resolve exactly like seeded ones. See lib/studio/library.ts.
const LIBRARY_FINISH_MAP = new Map<string, Finish>();

export function registerLibraryFinishes(finishes: Finish[]): void {
  LIBRARY_FINISH_MAP.clear();
  for (const f of finishes) LIBRARY_FINISH_MAP.set(f.id, f);
}

export function getLibraryFinishesByKind(kind: FinishKind): Finish[] {
  return [...LIBRARY_FINISH_MAP.values()].filter((f) => f.kind === kind);
}

export function getFinish(id: string | undefined | null, fallback: string): Finish {
  if (id) {
    const f = FINISH_MAP.get(id) ?? LIBRARY_FINISH_MAP.get(id);
    if (f) return f;
  }
  return FINISH_MAP.get(fallback)!;
}

// Legacy material-registry ids (v1 rooms) → studio finish ids.
// Only the handful that were ever defaults; anything unknown maps per-kind.
export const LEGACY_FINISH_MAP: Record<string, string> = {
  "hardwood-walnut-dark": "floor-walnut-dark",
  "hardwood-oak-natural": "floor-oak-natural",
  "hardwood-oak-white": "floor-oak-white",
  "tile-porcelain-white": "floor-tile-porcelain",
  "paint-white": "paint-pure-white",
  "paint-greige": "paint-agreeable-greige",
};

export const DEFAULT_SURFACES = {
  floor: "floor-oak-natural",
  wall: "paint-soft-chalk",
  ceiling: "paint-pure-white",
  counter: "counter-quartz-white",
  cabinet: "cab-white",
  island: "cab-navy",
  metal: "metal-stainless",
} as const;
