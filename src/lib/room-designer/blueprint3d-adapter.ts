// Adapter between ProBuild's RoomDesign/RoomAsset Prisma shape and the in-memory
// scene used by the canvas. This is the seam that later stages (GLTF models in
// Stage 1, PBR materials in Stage 2) hook into without the DB or UI knowing.
//
// FUTURE LIDAR: `importFromProBuild` is also the place where a USDZ/RoomPlan
// payload will be funneled — it produces the same RoomSnapshot shape the canvas
// consumes.

import type { PlacedAsset, RoomLayout, RoomLighting, RoomSnapshot, RoomType } from "@/components/room-designer/types";
import { buildDefaultLayout } from "@/components/room-designer/types";
import { DEFAULT_PRESET, HDRI_PRESETS, type HdriPreset } from "@/lib/room-designer/hdri-presets";

// DB shape (matches Prisma RoomDesign + RoomAsset[]).
export interface DbRoomAsset {
    id: string;
    assetType: string;
    assetId: string;
    positionX: number;
    positionY: number;
    positionZ: number;
    rotationY: number;
    scaleX: number;
    scaleY: number;
    scaleZ: number;
    metadata: unknown;
}

export interface DbRoomDesign {
    id: string;
    name: string;
    roomType: string;
    // layoutJson is typed as Json in Prisma. We validate shape at the boundary here.
    layoutJson: unknown;
    assets: DbRoomAsset[];
}

// Payload written back to the DB on save.
export interface RoomDesignPayload {
    layoutJson: RoomLayout;
    assets: Array<Omit<DbRoomAsset, "id"> & { id?: string }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// DB → in-memory scene
// ─────────────────────────────────────────────────────────────────────────────
export function importFromProBuild(row: DbRoomDesign): RoomSnapshot {
    const layout = parseLayout(row.layoutJson);
    const assets: PlacedAsset[] = row.assets.map(blueprintToAsset);
    return {
        roomId: row.id,
        roomType: normalizeRoomType(row.roomType),
        layout,
        assets,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// in-memory scene → DB payload
// ─────────────────────────────────────────────────────────────────────────────
export function exportToProBuild(snapshot: RoomSnapshot): RoomDesignPayload {
    return {
        layoutJson: snapshot.layout,
        assets: snapshot.assets.map(assetToBlueprint),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Single-asset conversions
// ─────────────────────────────────────────────────────────────────────────────
export function blueprintToAsset(row: DbRoomAsset): PlacedAsset {
    return {
        id: row.id,
        assetId: row.assetId,
        assetType: row.assetType as PlacedAsset["assetType"],
        position: { x: row.positionX, y: row.positionY, z: row.positionZ },
        rotationY: row.rotationY,
        scale: { x: row.scaleX, y: row.scaleY, z: row.scaleZ },
        metadata:
            row.metadata && typeof row.metadata === "object"
                ? (row.metadata as Record<string, unknown>)
                : undefined,
    };
}

export function assetToBlueprint(asset: PlacedAsset): Omit<DbRoomAsset, "id"> & { id?: string } {
    return {
        id: asset.id.startsWith("temp-") ? undefined : asset.id, // let DB mint IDs for new placements
        assetType: asset.assetType,
        assetId: asset.assetId,
        positionX: asset.position.x,
        positionY: asset.position.y,
        positionZ: asset.position.z,
        rotationY: asset.rotationY,
        scaleX: asset.scale.x,
        scaleY: asset.scale.y,
        scaleZ: asset.scale.z,
        metadata: asset.metadata ?? null,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function parseLayout(raw: unknown): RoomLayout {
    if (!raw || typeof raw !== "object") return buildDefaultLayout();
    const obj = raw as Partial<RoomLayout>;
    if (!obj.dimensions || !Array.isArray(obj.walls) || !obj.camera) {
        return buildDefaultLayout();
    }
    return {
        dimensions: obj.dimensions,
        walls: obj.walls,
        camera: obj.camera,
        surfaces: obj.surfaces ?? {},
        lighting: parseLighting(obj.lighting),
    };
}

// Stage 4: lighting defaults in when older rooms have no `lighting` block.
// Unknown preset keys degrade to DEFAULT_PRESET rather than being dropped.
function parseLighting(raw: unknown): RoomLighting {
    if (!raw || typeof raw !== "object") return { hdriPreset: DEFAULT_PRESET };
    const obj = raw as Partial<RoomLighting>;
    const key = obj.hdriPreset as HdriPreset | undefined;
    if (key && key in HDRI_PRESETS) return { hdriPreset: key };
    return { hdriPreset: DEFAULT_PRESET };
}

function normalizeRoomType(rt: string): RoomType {
    const valid: RoomType[] = ["kitchen", "bathroom", "laundry", "bedroom", "other"];
    return (valid as string[]).includes(rt) ? (rt as RoomType) : "other";
}
