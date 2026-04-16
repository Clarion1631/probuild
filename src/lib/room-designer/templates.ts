// Room Designer templates. Each template is a pure builder that returns a
// fresh RoomLayout + a list of Omit<PlacedAsset, "id"> assets to seed. The
// POST /api/rooms route applies these via a single nested prisma create —
// no interactive transactions (incompatible with Supabase PgBouncer).
//
// Coordinate conventions (match buildDefaultLayout):
//   - origin at room center
//   - X axis = width; Z axis = length; Y axis = height
//   - walls: north (z=-halfL), south (z=+halfL), east (x=+halfW), west (x=-halfW)
//   - wall thickness = 0.1m
//   - PlacedAsset.position.y is an offset (0 = floor-based); AssetNode adds
//     height/2 at render time, so floor items stay at y=0 here
//
// Rotation convention (radians, CCW around +Y looking down):
//   - north wall items: rotationY = 0         (face +Z, into room)
//   - south wall items: rotationY = Math.PI   (face -Z)
//   - east  wall items: rotationY = -Math.PI/2 (face -X)
//   - west  wall items: rotationY = +Math.PI/2 (face +X)
//
// Stage 0 box fallback is rotation-insensitive for square footprints; we still
// set rotations so Stage 2 GLBs land correctly without edit.

import {
    type PlacedAsset,
    type RoomLayout,
    type RoomType,
} from "@/components/room-designer/types";
import { getAsset, type Asset } from "./asset-registry";

const FT = 0.3048; // meters per foot
const WALL_THICKNESS = 0.1;

export type TemplateKey =
    | "galley"
    | "l_shape"
    | "u_shape"
    | "island"
    | "master_bath"
    | "guest_bath"
    | "half_bath";

export interface TemplateDescriptor {
    key: TemplateKey;
    label: string;
    roomType: RoomType;
    widthFt: number;
    lengthFt: number;
    description: string;
}

export interface TemplateSeed {
    roomType: RoomType;
    layout: RoomLayout;
    assets: Array<Omit<PlacedAsset, "id">>;
}

export const ROOM_TEMPLATES: Record<TemplateKey, TemplateDescriptor> = {
    galley: {
        key: "galley",
        label: "Galley Kitchen",
        roomType: "kitchen",
        widthFt: 8,
        lengthFt: 12,
        description: "Two rows of base cabinets along long walls with sink + stove",
    },
    l_shape: {
        key: "l_shape",
        label: "L-Shape Kitchen",
        roomType: "kitchen",
        widthFt: 10,
        lengthFt: 12,
        description: "L-run with corner cabinet, sink, and stove",
    },
    u_shape: {
        key: "u_shape",
        label: "U-Shape Kitchen",
        roomType: "kitchen",
        widthFt: 12,
        lengthFt: 12,
        description: "Cabinets on three walls; sink at back, stove on right",
    },
    island: {
        key: "island",
        label: "Island Kitchen",
        roomType: "kitchen",
        widthFt: 14,
        lengthFt: 16,
        description: "Back-wall perimeter run plus freestanding 48″ island",
    },
    master_bath: {
        key: "master_bath",
        label: "Master Bathroom",
        roomType: "bathroom",
        widthFt: 10,
        lengthFt: 12,
        description: "Double vanity, freestanding tub, and toilet",
    },
    guest_bath: {
        key: "guest_bath",
        label: "Guest Bathroom",
        roomType: "bathroom",
        widthFt: 8,
        lengthFt: 8,
        description: "Single vanity, toilet, and shower base",
    },
    half_bath: {
        key: "half_bath",
        label: "Half Bath",
        roomType: "bathroom",
        widthFt: 5,
        lengthFt: 8,
        description: "Single vanity and toilet",
    },
};

export const TEMPLATE_ORDER: TemplateKey[] = [
    "galley",
    "l_shape",
    "u_shape",
    "island",
    "master_bath",
    "guest_bath",
    "half_bath",
];

/** Build a walled rectangular layout from foot dimensions. */
function buildLayoutFromFt(widthFt: number, lengthFt: number, heightFt = 8): RoomLayout {
    const W = widthFt * FT;
    const L = lengthFt * FT;
    const H = heightFt * FT;
    const halfW = W / 2;
    const halfL = L / 2;
    return {
        dimensions: { width: W, length: L, height: H },
        walls: [
            {
                id: "wall-n",
                start: { x: -halfW, z: -halfL },
                end: { x: halfW, z: -halfL },
                height: H,
                thickness: WALL_THICKNESS,
                surface: "wall-north",
            },
            {
                id: "wall-s",
                start: { x: halfW, z: halfL },
                end: { x: -halfW, z: halfL },
                height: H,
                thickness: WALL_THICKNESS,
                surface: "wall-south",
            },
            {
                id: "wall-e",
                start: { x: halfW, z: -halfL },
                end: { x: halfW, z: halfL },
                height: H,
                thickness: WALL_THICKNESS,
                surface: "wall-east",
            },
            {
                id: "wall-w",
                start: { x: -halfW, z: halfL },
                end: { x: -halfW, z: -halfL },
                height: H,
                thickness: WALL_THICKNESS,
                surface: "wall-west",
            },
        ],
        camera: { position: [W, H * 1.5, L], target: [0, H / 2, 0] },
        surfaces: { floor: null, ceiling: null },
    };
}

type Seed = Omit<PlacedAsset, "id">;

function seed(
    asset: Asset,
    position: { x: number; y: number; z: number },
    rotationY: number,
): Seed {
    return {
        assetId: asset.id,
        assetType: asset.category,
        position,
        rotationY,
        scale: { x: 1, y: 1, z: 1 },
    };
}

function lookup(id: string): Asset {
    const a = getAsset(id);
    if (!a) throw new Error(`Template references unknown asset "${id}"`);
    return a;
}

/**
 * Place an asset against the NORTH wall (z = -halfL), base on floor, back
 * touching the interior wall face. `xFromLeft` is in METERS measured from the
 * west wall's interior face.
 */
function northWall(
    asset: Asset,
    xFromLeft: number,
    dims: { width: number; length: number },
): Seed {
    const halfW = dims.width / 2;
    const halfL = dims.length / 2;
    const x = -halfW + xFromLeft + asset.dimensions.width / 2;
    const z = -halfL + WALL_THICKNESS / 2 + asset.dimensions.depth / 2;
    return seed(asset, { x, y: 0, z }, 0);
}

function southWall(
    asset: Asset,
    xFromLeft: number,
    dims: { width: number; length: number },
): Seed {
    const halfW = dims.width / 2;
    const halfL = dims.length / 2;
    const x = -halfW + xFromLeft + asset.dimensions.width / 2;
    const z = halfL - WALL_THICKNESS / 2 - asset.dimensions.depth / 2;
    return seed(asset, { x, y: 0, z }, Math.PI);
}

function eastWall(
    asset: Asset,
    zFromNorth: number,
    dims: { width: number; length: number },
): Seed {
    const halfW = dims.width / 2;
    const halfL = dims.length / 2;
    const z = -halfL + zFromNorth + asset.dimensions.width / 2;
    const x = halfW - WALL_THICKNESS / 2 - asset.dimensions.depth / 2;
    return seed(asset, { x, y: 0, z }, -Math.PI / 2);
}

function westWall(
    asset: Asset,
    zFromNorth: number,
    dims: { width: number; length: number },
): Seed {
    const halfW = dims.width / 2;
    const halfL = dims.length / 2;
    const z = -halfL + zFromNorth + asset.dimensions.width / 2;
    const x = -halfW + WALL_THICKNESS / 2 + asset.dimensions.depth / 2;
    return seed(asset, { x, y: 0, z }, Math.PI / 2);
}

/** Fill a wall with a repeating asset, left-to-right. */
function runAlongNorth(
    asset: Asset,
    dims: { width: number; length: number },
    startFt: number,
    endFt: number,
): Seed[] {
    const pieces: Seed[] = [];
    let cursorM = startFt * FT;
    const endM = endFt * FT;
    while (cursorM + asset.dimensions.width <= endM + 1e-6) {
        pieces.push(northWall(asset, cursorM, dims));
        cursorM += asset.dimensions.width;
    }
    return pieces;
}

function runAlongSouth(
    asset: Asset,
    dims: { width: number; length: number },
    startFt: number,
    endFt: number,
): Seed[] {
    const pieces: Seed[] = [];
    let cursorM = startFt * FT;
    const endM = endFt * FT;
    while (cursorM + asset.dimensions.width <= endM + 1e-6) {
        pieces.push(southWall(asset, cursorM, dims));
        cursorM += asset.dimensions.width;
    }
    return pieces;
}

function runAlongWest(
    asset: Asset,
    dims: { width: number; length: number },
    startFt: number,
    endFt: number,
): Seed[] {
    const pieces: Seed[] = [];
    let cursorM = startFt * FT;
    const endM = endFt * FT;
    while (cursorM + asset.dimensions.width <= endM + 1e-6) {
        pieces.push(westWall(asset, cursorM, dims));
        cursorM += asset.dimensions.width;
    }
    return pieces;
}

function runAlongEast(
    asset: Asset,
    dims: { width: number; length: number },
    startFt: number,
    endFt: number,
): Seed[] {
    const pieces: Seed[] = [];
    let cursorM = startFt * FT;
    const endM = endFt * FT;
    while (cursorM + asset.dimensions.width <= endM + 1e-6) {
        pieces.push(eastWall(asset, cursorM, dims));
        cursorM += asset.dimensions.width;
    }
    return pieces;
}

// ─────────────── Template builders ───────────────

function galley(): TemplateSeed {
    const layout = buildLayoutFromFt(8, 12);
    const dims = { width: layout.dimensions.width, length: layout.dimensions.length };
    const base = lookup("base-cabinet-24");
    const sink = lookup("sink-base-36");
    const stove = lookup("stove-range-30");
    const dishwasher = lookup("dishwasher");

    const assets: Seed[] = [
        // West wall: base cabinets + sink near the middle.
        // NOTE: single-item `*Wall()` calls want meters; `runAlong*` wants feet.
        // When chaining offsets, keep meters for `*Wall` (use raw .dimensions.width)
        // and feet for `runAlong*` (divide .dimensions.width by FT).
        ...runAlongWest(base, dims, 0, 3),
        westWall(sink, 3 * FT, dims),
        westWall(dishwasher, 3 * FT + sink.dimensions.width, dims),
        ...runAlongWest(base, dims, 3 + sink.dimensions.width / FT + dishwasher.dimensions.width / FT, 12),
        // East wall: base cabinets + stove at the middle
        ...runAlongEast(base, dims, 0, 4),
        eastWall(stove, 4 * FT, dims),
        ...runAlongEast(base, dims, 4 + stove.dimensions.width / FT, 12),
    ];
    return { roomType: "kitchen", layout, assets };
}

function lShape(): TemplateSeed {
    const layout = buildLayoutFromFt(10, 12);
    const dims = { width: layout.dimensions.width, length: layout.dimensions.length };
    const base = lookup("base-cabinet-36");
    const corner = lookup("corner-cabinet");
    const sink = lookup("sink-base-36");
    const stove = lookup("stove-range-30");

    const assets: Seed[] = [
        // North wall run with corner at the west end.
        // `northWall` arg is meters; `runAlongNorth` args are feet.
        northWall(corner, 0, dims),
        ...runAlongNorth(base, dims, corner.dimensions.width / FT, 10 - sink.dimensions.width / FT),
        northWall(sink, 10 * FT - sink.dimensions.width, dims),
        // West wall run heading south from the corner
        ...runAlongWest(base, dims, corner.dimensions.width / FT, 6),
        westWall(stove, 6 * FT, dims),
    ];
    return { roomType: "kitchen", layout, assets };
}

function uShape(): TemplateSeed {
    const layout = buildLayoutFromFt(12, 12);
    const dims = { width: layout.dimensions.width, length: layout.dimensions.length };
    const base = lookup("base-cabinet-36");
    const corner = lookup("corner-cabinet");
    const sink = lookup("sink-base-36");
    const stove = lookup("stove-range-30");

    const assets: Seed[] = [
        // North wall (back): corner — run — sink — run — corner
        northWall(corner, 0, dims),
        ...runAlongNorth(base, dims, corner.dimensions.width / FT, 4.5),
        northWall(sink, 4.5 * FT, dims),
        ...runAlongNorth(
            base,
            dims,
            4.5 + sink.dimensions.width / FT,
            12 - corner.dimensions.width / FT,
        ),
        northWall(corner, 12 * FT - corner.dimensions.width, dims),
        // West arm
        ...runAlongWest(base, dims, corner.dimensions.width / FT, 8),
        // East arm with stove
        ...runAlongEast(base, dims, corner.dimensions.width / FT, 5),
        eastWall(stove, 5 * FT, dims),
        ...runAlongEast(base, dims, 5 + stove.dimensions.width / FT, 8),
    ];
    return { roomType: "kitchen", layout, assets };
}

function island(): TemplateSeed {
    const layout = buildLayoutFromFt(14, 16);
    const dims = { width: layout.dimensions.width, length: layout.dimensions.length };
    const base = lookup("base-cabinet-36");
    const sink = lookup("sink-base-36");
    const stove = lookup("stove-range-30");
    const islandCab = lookup("island-cabinet");
    const fridge = lookup("refrigerator-french");

    const assets: Seed[] = [
        // North wall: fridge — run — sink — run — stove
        northWall(fridge, 0, dims),
        ...runAlongNorth(base, dims, fridge.dimensions.width / FT, 6),
        northWall(sink, 6 * FT, dims),
        ...runAlongNorth(base, dims, 6 + sink.dimensions.width / FT, 11),
        northWall(stove, 11 * FT, dims),
        ...runAlongNorth(base, dims, 11 + stove.dimensions.width / FT, 14),
        // Freestanding island — centered, offset 3ft from the back wall
        seed(
            islandCab,
            { x: 0, y: 0, z: -layout.dimensions.length / 2 + 4 * FT + islandCab.dimensions.depth / 2 },
            0,
        ),
    ];
    return { roomType: "kitchen", layout, assets };
}

function masterBath(): TemplateSeed {
    const layout = buildLayoutFromFt(10, 12);
    const dims = { width: layout.dimensions.width, length: layout.dimensions.length };
    const vanity = lookup("vanity-double");
    const tub = lookup("bathtub-freestanding");
    const toilet = lookup("toilet-standard");
    const mirror = lookup("bathroom-mirror");

    const halfW = dims.width / 2;
    const halfL = dims.length / 2;

    const assets: Seed[] = [
        // Long (south) wall: double vanity, centered
        southWall(vanity, (10 * FT - vanity.dimensions.width) / FT, dims),
        // Mirror above the vanity (wall-mounted, higher offset)
        {
            assetId: mirror.id,
            assetType: mirror.category,
            position: {
                x: 0,
                y: 1.2, // 1.2m above the floor, above vanity top
                z: halfL - WALL_THICKNESS / 2 - mirror.dimensions.depth / 2,
            },
            rotationY: Math.PI,
            scale: { x: 1, y: 1, z: 1 },
        },
        // Tub against the north wall, centered
        {
            assetId: tub.id,
            assetType: tub.category,
            position: {
                x: 0,
                y: 0,
                z: -halfL + WALL_THICKNESS / 2 + tub.dimensions.depth / 2,
            },
            rotationY: 0,
            scale: { x: 1, y: 1, z: 1 },
        },
        // Toilet on the east wall
        {
            assetId: toilet.id,
            assetType: toilet.category,
            position: {
                x: halfW - WALL_THICKNESS / 2 - toilet.dimensions.depth / 2,
                y: 0,
                z: halfL - 3 * FT,
            },
            rotationY: -Math.PI / 2,
            scale: { x: 1, y: 1, z: 1 },
        },
    ];
    return { roomType: "bathroom", layout, assets };
}

function guestBath(): TemplateSeed {
    const layout = buildLayoutFromFt(8, 8);
    const dims = { width: layout.dimensions.width, length: layout.dimensions.length };
    const vanity = lookup("vanity-double"); // treat as single-wide — user will swap if needed
    const toilet = lookup("toilet-standard");
    const shower = lookup("shower-base");
    const mirror = lookup("bathroom-mirror");

    const halfW = dims.width / 2;
    const halfL = dims.length / 2;

    const assets: Seed[] = [
        // West wall vanity, north-end
        westWall(vanity, 0.5, dims),
        {
            assetId: mirror.id,
            assetType: mirror.category,
            position: {
                x: -halfW + WALL_THICKNESS / 2 + mirror.dimensions.depth / 2,
                y: 1.2,
                z: -halfL + 0.5 * FT + vanity.dimensions.width / 2,
            },
            rotationY: Math.PI / 2,
            scale: { x: 1, y: 1, z: 1 },
        },
        // Shower base, south-east corner
        {
            assetId: shower.id,
            assetType: shower.category,
            position: {
                x: halfW - WALL_THICKNESS / 2 - shower.dimensions.depth / 2,
                y: 0,
                z: halfL - WALL_THICKNESS / 2 - shower.dimensions.width / 2,
            },
            rotationY: -Math.PI / 2,
            scale: { x: 1, y: 1, z: 1 },
        },
        // Toilet, south-west
        {
            assetId: toilet.id,
            assetType: toilet.category,
            position: {
                x: -halfW + WALL_THICKNESS / 2 + toilet.dimensions.depth / 2,
                y: 0,
                z: halfL - 2 * FT,
            },
            rotationY: Math.PI / 2,
            scale: { x: 1, y: 1, z: 1 },
        },
    ];
    return { roomType: "bathroom", layout, assets };
}

function halfBath(): TemplateSeed {
    const layout = buildLayoutFromFt(5, 8);
    const dims = { width: layout.dimensions.width, length: layout.dimensions.length };
    const vanity = lookup("vanity-double"); // narrow rooms → user will swap
    const toilet = lookup("toilet-standard");
    const mirror = lookup("bathroom-mirror");

    const halfL = dims.length / 2;
    const halfW = dims.width / 2;

    const assets: Seed[] = [
        // North wall vanity, centered on X
        {
            assetId: vanity.id,
            assetType: vanity.category,
            position: {
                x: 0,
                y: 0,
                z: -halfL + WALL_THICKNESS / 2 + vanity.dimensions.depth / 2,
            },
            rotationY: 0,
            scale: { x: 1, y: 1, z: 1 },
        },
        {
            assetId: mirror.id,
            assetType: mirror.category,
            position: {
                x: 0,
                y: 1.2,
                z: -halfL + WALL_THICKNESS / 2 + mirror.dimensions.depth / 2,
            },
            rotationY: 0,
            scale: { x: 1, y: 1, z: 1 },
        },
        // Toilet on the east wall, mid-room
        {
            assetId: toilet.id,
            assetType: toilet.category,
            position: {
                x: halfW - WALL_THICKNESS / 2 - toilet.dimensions.depth / 2,
                y: 0,
                z: 0,
            },
            rotationY: -Math.PI / 2,
            scale: { x: 1, y: 1, z: 1 },
        },
    ];
    return { roomType: "bathroom", layout, assets };
}

const TEMPLATE_BUILDERS: Record<TemplateKey, () => TemplateSeed> = {
    galley,
    l_shape: lShape,
    u_shape: uShape,
    island,
    master_bath: masterBath,
    guest_bath: guestBath,
    half_bath: halfBath,
};

/** Build the seed payload for a template. Throws if the key is unknown. */
export function buildTemplateSeed(key: TemplateKey): TemplateSeed {
    const build = TEMPLATE_BUILDERS[key];
    if (!build) throw new Error(`Unknown template key: ${key}`);
    return build();
}

/** Narrow a string to a known TemplateKey, or return null. */
export function parseTemplateKey(v: unknown): TemplateKey | null {
    if (typeof v !== "string") return null;
    return (v in ROOM_TEMPLATES) ? (v as TemplateKey) : null;
}
