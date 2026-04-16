// Master material registry for the Room Designer.
//
// STAGE 2 (today): every entry is a flat-color placeholder. `hasPBR = false`
// and `texturePath = null` (or a speculative path for wood) — the renderer
// resolves these as MeshStandardMaterial with a hex color.
//
// STAGE 1 HANDOFF: once the PBR asset pipeline finishes downloading textures
// into `/public/assets/room-designer/textures/`, flip `hasPBR: true` on each
// material and set `texturePath`. The renderer (SurfaceMaterial.tsx) picks up
// the real PBR maps with zero refactor.
//
// Per-material file layout Stage 1 will populate:
//   {texturePath}_albedo.jpg
//   {texturePath}_normal.jpg
//   {texturePath}_roughness.jpg
//   {texturePath}_metalness.jpg
//   {texturePath}_ao.jpg

export type MaterialCategory =
    | "flooring"
    | "wall-paint"
    | "tile"
    | "countertop"
    | "cabinet-finish"
    | "backsplash";

export interface Material {
    id: string;
    name: string;
    category: MaterialCategory;
    /** Base path (no extension, no _suffix) to the PBR map set. `null` until Stage 1. */
    texturePath: string | null;
    /** Hex fallback — always present so Stage 2 renders correctly without textures. */
    color: string;
    /** When true AND texturePath is set, the renderer loads the 5-map PBR set. */
    hasPBR: boolean;
    tags: string[];
    /**
     * Composite materials (e.g. two-tone cabinet) carry child-material ids.
     * `resolveMaterial()` unpacks these before the renderer reads color/texture.
     */
    metadata?: { upper?: string; lower?: string };
}

// Door-style geometry toggles — stored on cabinet asset metadata, not in this registry.
// Stage 2 stores the choice; Stage 3 adds visual geometry variants with the GLTF swap.
export const CABINET_DOOR_STYLES = [
    "shaker",
    "flat-panel",
    "raised-panel",
    "glass-insert",
    "open",
] as const;
export type CabinetDoorStyle = (typeof CABINET_DOOR_STYLES)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Registry — 62 materials (15 flooring + 20 wall-paint + 8 countertop + 10 backsplash + 9 cabinet-finish)
// The 'tile' category has no entries yet — reserved for future wall-tile materials.
// ─────────────────────────────────────────────────────────────────────────────
export const MATERIAL_REGISTRY: Material[] = [
    // ── Flooring (15) ─────────────────────────────────────────────────────────
    { id: "hardwood-oak-natural",   name: "Hardwood Oak Natural",   category: "flooring", texturePath: null, color: "#C4A882", hasPBR: false, tags: ["wood", "natural", "warm"] },
    { id: "hardwood-walnut-dark",   name: "Hardwood Walnut Dark",   category: "flooring", texturePath: null, color: "#5C3D2E", hasPBR: false, tags: ["wood", "dark", "rich"] },
    { id: "tile-white-12x24",       name: 'Tile White 12"x24"',     category: "flooring", texturePath: null, color: "#F0EDE8", hasPBR: false, tags: ["tile", "white", "modern"] },
    { id: "tile-gray-marble",       name: "Tile Gray Marble",       category: "flooring", texturePath: null, color: "#A8A39C", hasPBR: false, tags: ["tile", "marble", "gray"] },
    { id: "tile-hex-white",         name: "Tile Hex White",         category: "flooring", texturePath: null, color: "#F5F2EE", hasPBR: false, tags: ["tile", "hex", "white"] },
    { id: "concrete-polished",      name: "Concrete Polished",      category: "flooring", texturePath: null, color: "#8A8A8A", hasPBR: false, tags: ["concrete", "industrial"] },
    { id: "vinyl-plank-gray",       name: "Vinyl Plank Gray",       category: "flooring", texturePath: null, color: "#7A7570", hasPBR: false, tags: ["vinyl", "plank", "gray"] },
    { id: "carpet-neutral",         name: "Carpet Neutral",         category: "flooring", texturePath: null, color: "#C4B89A", hasPBR: false, tags: ["carpet", "soft", "neutral"] },
    { id: "travertine",             name: "Travertine",             category: "flooring", texturePath: null, color: "#D4C4A8", hasPBR: false, tags: ["stone", "travertine", "warm"] },
    { id: "slate-dark",             name: "Slate Dark",             category: "flooring", texturePath: null, color: "#4A4540", hasPBR: false, tags: ["stone", "slate", "dark"] },
    { id: "terracotta",             name: "Terracotta",             category: "flooring", texturePath: null, color: "#C4724A", hasPBR: false, tags: ["tile", "terracotta", "warm"] },
    { id: "bamboo",                 name: "Bamboo",                 category: "flooring", texturePath: null, color: "#D4C090", hasPBR: false, tags: ["bamboo", "eco"] },
    { id: "cork",                   name: "Cork",                   category: "flooring", texturePath: null, color: "#C4A870", hasPBR: false, tags: ["cork", "eco"] },
    { id: "porcelain-wood-look",    name: "Porcelain Wood-Look",    category: "flooring", texturePath: null, color: "#B4906A", hasPBR: false, tags: ["porcelain", "wood-look"] },
    { id: "tile-herringbone",       name: "Tile Herringbone",       category: "flooring", texturePath: null, color: "#E8E0D0", hasPBR: false, tags: ["tile", "herringbone", "pattern"] },

    // ── Wall Paint (20) ───────────────────────────────────────────────────────
    { id: "white-bright",      name: "White Bright",      category: "wall-paint", texturePath: null, color: "#FFFFFF", hasPBR: false, tags: ["white", "bright"] },
    { id: "white-warm",        name: "White Warm",        category: "wall-paint", texturePath: null, color: "#F5F0E8", hasPBR: false, tags: ["white", "warm"] },
    { id: "white-soft",        name: "White Soft",        category: "wall-paint", texturePath: null, color: "#EDE8E0", hasPBR: false, tags: ["white", "soft"] },
    { id: "gray-light",        name: "Gray Light",        category: "wall-paint", texturePath: null, color: "#D4D0CB", hasPBR: false, tags: ["gray", "light"] },
    { id: "gray-medium",       name: "Gray Medium",       category: "wall-paint", texturePath: null, color: "#A8A39C", hasPBR: false, tags: ["gray", "medium"] },
    { id: "gray-dark",         name: "Gray Dark",         category: "wall-paint", texturePath: null, color: "#6B6560", hasPBR: false, tags: ["gray", "dark"] },
    { id: "blue-navy",         name: "Blue Navy",         category: "wall-paint", texturePath: null, color: "#1B2A4A", hasPBR: false, tags: ["blue", "navy", "dark"] },
    { id: "blue-slate",        name: "Blue Slate",        category: "wall-paint", texturePath: null, color: "#4A6278", hasPBR: false, tags: ["blue", "slate"] },
    { id: "blue-light",        name: "Blue Light",        category: "wall-paint", texturePath: null, color: "#B8D4E0", hasPBR: false, tags: ["blue", "light"] },
    { id: "green-sage",        name: "Green Sage",        category: "wall-paint", texturePath: null, color: "#8A9E85", hasPBR: false, tags: ["green", "sage"] },
    { id: "green-forest",      name: "Green Forest",      category: "wall-paint", texturePath: null, color: "#2D4A35", hasPBR: false, tags: ["green", "forest", "dark"] },
    { id: "green-mint",        name: "Green Mint",        category: "wall-paint", texturePath: null, color: "#C5DDD0", hasPBR: false, tags: ["green", "mint", "light"] },
    { id: "beige-warm",        name: "Beige Warm",        category: "wall-paint", texturePath: null, color: "#D4C4A8", hasPBR: false, tags: ["beige", "warm"] },
    { id: "tan-camel",         name: "Tan Camel",         category: "wall-paint", texturePath: null, color: "#C4A882", hasPBR: false, tags: ["tan", "camel"] },
    { id: "brown-chocolate",   name: "Brown Chocolate",   category: "wall-paint", texturePath: null, color: "#5C3D2E", hasPBR: false, tags: ["brown", "dark"] },
    { id: "terracotta-warm",   name: "Terracotta Warm",   category: "wall-paint", texturePath: null, color: "#C4724A", hasPBR: false, tags: ["terracotta", "warm"] },
    { id: "black-soft",        name: "Black Soft",        category: "wall-paint", texturePath: null, color: "#2A2A2A", hasPBR: false, tags: ["black", "dark"] },
    { id: "yellow-butter",     name: "Yellow Butter",     category: "wall-paint", texturePath: null, color: "#F0E0A0", hasPBR: false, tags: ["yellow", "warm"] },
    { id: "blush-pink",        name: "Blush Pink",        category: "wall-paint", texturePath: null, color: "#E8C4B8", hasPBR: false, tags: ["pink", "blush"] },
    { id: "purple-soft",       name: "Purple Soft",       category: "wall-paint", texturePath: null, color: "#9A8AAA", hasPBR: false, tags: ["purple", "soft"] },

    // ── Countertops (8) ───────────────────────────────────────────────────────
    { id: "granite-black",         name: "Granite Black",         category: "countertop", texturePath: null, color: "#2A2A2A", hasPBR: false, tags: ["granite", "black"] },
    { id: "marble-white-carrara",  name: "Marble White Carrara",  category: "countertop", texturePath: null, color: "#F0EDE8", hasPBR: false, tags: ["marble", "carrara", "white"] },
    { id: "quartz-white",          name: "Quartz White",          category: "countertop", texturePath: null, color: "#F5F2EE", hasPBR: false, tags: ["quartz", "white"] },
    { id: "quartz-gray",           name: "Quartz Gray",           category: "countertop", texturePath: null, color: "#A8A39C", hasPBR: false, tags: ["quartz", "gray"] },
    { id: "butcher-block",         name: "Butcher Block",         category: "countertop", texturePath: null, color: "#C4A882", hasPBR: false, tags: ["wood", "butcher-block"] },
    { id: "concrete-counter",      name: "Concrete Counter",      category: "countertop", texturePath: null, color: "#8A8A8A", hasPBR: false, tags: ["concrete"] },
    { id: "laminate-white",        name: "Laminate White",        category: "countertop", texturePath: null, color: "#F5F0E8", hasPBR: false, tags: ["laminate", "white"] },
    { id: "soapstone",             name: "Soapstone",             category: "countertop", texturePath: null, color: "#4A4540", hasPBR: false, tags: ["stone", "soapstone", "dark"] },

    // ── Backsplash (10) ───────────────────────────────────────────────────────
    { id: "subway-white",      name: "Subway White",      category: "backsplash", texturePath: null, color: "#F0EDE8", hasPBR: false, tags: ["subway", "white", "classic"] },
    { id: "subway-gray",       name: "Subway Gray",       category: "backsplash", texturePath: null, color: "#A8A39C", hasPBR: false, tags: ["subway", "gray"] },
    { id: "hex-white-small",   name: "Hex White Small",   category: "backsplash", texturePath: null, color: "#F5F2EE", hasPBR: false, tags: ["hex", "white"] },
    { id: "penny-round",       name: "Penny Round",       category: "backsplash", texturePath: null, color: "#E8E0D0", hasPBR: false, tags: ["penny", "round"] },
    { id: "arabesque",         name: "Arabesque",         category: "backsplash", texturePath: null, color: "#D4C4A8", hasPBR: false, tags: ["arabesque", "pattern"] },
    { id: "zellige",           name: "Zellige",           category: "backsplash", texturePath: null, color: "#C4A882", hasPBR: false, tags: ["zellige", "moroccan"] },
    { id: "brick-red",         name: "Brick Red",         category: "backsplash", texturePath: null, color: "#8A4A30", hasPBR: false, tags: ["brick", "red", "rustic"] },
    { id: "chevron-white",     name: "Chevron White",     category: "backsplash", texturePath: null, color: "#F0EDE8", hasPBR: false, tags: ["chevron", "white", "pattern"] },
    { id: "geometric-black",   name: "Geometric Black",   category: "backsplash", texturePath: null, color: "#2A2A2A", hasPBR: false, tags: ["geometric", "black"] },
    { id: "fish-scale",        name: "Fish Scale",        category: "backsplash", texturePath: null, color: "#B8D4E0", hasPBR: false, tags: ["fish-scale", "blue"] },

    // ── Cabinet Finishes (9) ──────────────────────────────────────────────────
    // Wood finishes carry a speculative texturePath (Stage 1 will drop real maps there).
    // hasPBR stays false until the files exist — they render as flat color today.
    { id: "white-shaker",   name: "White Shaker",   category: "cabinet-finish", texturePath: null, color: "#F5F0E8", hasPBR: false, tags: ["cabinet", "white", "shaker"] },
    { id: "gray-shaker",    name: "Gray Shaker",    category: "cabinet-finish", texturePath: null, color: "#6B7280", hasPBR: false, tags: ["cabinet", "gray", "shaker"] },
    { id: "navy-blue",      name: "Navy Blue",      category: "cabinet-finish", texturePath: null, color: "#1B2A4A", hasPBR: false, tags: ["cabinet", "navy", "blue"] },
    { id: "forest-green",   name: "Forest Green",   category: "cabinet-finish", texturePath: null, color: "#2D4A35", hasPBR: false, tags: ["cabinet", "green"] },
    { id: "natural-wood",   name: "Natural Wood",   category: "cabinet-finish", texturePath: "/assets/room-designer/textures/wood/oak-natural",  color: "#C4A882", hasPBR: false, tags: ["cabinet", "wood", "oak"] },
    { id: "dark-walnut",    name: "Dark Walnut",    category: "cabinet-finish", texturePath: "/assets/room-designer/textures/wood/walnut-dark",  color: "#5C3D2E", hasPBR: false, tags: ["cabinet", "wood", "walnut"] },
    {
        id: "two-tone",
        name: "Two-Tone (White / Wood)",
        category: "cabinet-finish",
        texturePath: null,
        color: "#C4A882", // MVP renders lower finish only — true two-tone split lands with Stage 3 GLTF cabinets
        hasPBR: false,
        tags: ["cabinet", "two-tone"],
        metadata: { upper: "white-shaker", lower: "natural-wood" },
    },
    { id: "black-matte",    name: "Black Matte",    category: "cabinet-finish", texturePath: null, color: "#1A1A1A", hasPBR: false, tags: ["cabinet", "black", "matte"] },
    { id: "cream",          name: "Cream",          category: "cabinet-finish", texturePath: null, color: "#F5F0E0", hasPBR: false, tags: ["cabinet", "cream"] },
];

// ─────────────────────────────────────────────────────────────────────────────
// Lookups
// ─────────────────────────────────────────────────────────────────────────────
export const MATERIALS_BY_CATEGORY: Record<MaterialCategory, Material[]> = {
    flooring: MATERIAL_REGISTRY.filter((m) => m.category === "flooring"),
    "wall-paint": MATERIAL_REGISTRY.filter((m) => m.category === "wall-paint"),
    tile: MATERIAL_REGISTRY.filter((m) => m.category === "tile"),
    countertop: MATERIAL_REGISTRY.filter((m) => m.category === "countertop"),
    "cabinet-finish": MATERIAL_REGISTRY.filter((m) => m.category === "cabinet-finish"),
    backsplash: MATERIAL_REGISTRY.filter((m) => m.category === "backsplash"),
};

const MATERIAL_BY_ID: Record<string, Material> = MATERIAL_REGISTRY.reduce(
    (acc, m) => {
        acc[m.id] = m;
        return acc;
    },
    {} as Record<string, Material>,
);

export function getMaterial(id: string | null | undefined): Material | undefined {
    if (!id) return undefined;
    return MATERIAL_BY_ID[id];
}

/**
 * Resolve a material id, unpacking composite "two-tone" into its `lower` child
 * so the renderer always reads a terminal material. Returns `undefined` if unknown.
 */
export function resolveMaterial(id: string | null | undefined): Material | undefined {
    const m = getMaterial(id);
    if (!m) return undefined;
    if (m.metadata?.lower) {
        return getMaterial(m.metadata.lower) ?? m;
    }
    return m;
}
