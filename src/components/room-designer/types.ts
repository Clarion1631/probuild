// Room Designer — core types.
//
// FUTURE MOBILE: all fields here are portable to React Native / Expo.
// Do not import from `next/*` or browser-only APIs in this file.
// FUTURE AR: positions use real-world meters so they map directly onto ARKit/ARCore anchors.
// FUTURE LIDAR: RoomLayout is designed to be populated from Apple RoomPlan USDZ output.

export type AssetCategory = "cabinet" | "appliance" | "fixture" | "window" | "door";

export type RoomType = "kitchen" | "bathroom" | "laundry" | "bedroom" | "other";

export type ViewMode = "2d" | "3d";

// Surfaces that can be re-materialed in Stage 2. Stage 0 stores them as null.
export type RoomSurface =
    | "floor"
    | "ceiling"
    | "wall-north"
    | "wall-south"
    | "wall-east"
    | "wall-west"
    | "backsplash"
    | "countertop"
    | "cabinet-face";

// All positions/dimensions are meters unless otherwise noted.
export interface Wall {
    id: string;
    start: { x: number; z: number };
    end: { x: number; z: number };
    height: number;
    thickness: number;
}

export interface RoomDimensions {
    width: number; // X axis
    length: number; // Z axis
    height: number; // Y axis (ceiling)
}

export interface CameraState {
    position: [number, number, number];
    target: [number, number, number];
}

export interface RoomLayout {
    dimensions: RoomDimensions;
    walls: Wall[];
    camera: CameraState;
    surfaces: Partial<Record<RoomSurface, string | null>>; // material id per surface (Stage 2+)
}

// One placed asset instance in a room. Maps 1:1 to RoomAsset row in Prisma.
export interface PlacedAsset {
    id: string;
    assetId: string; // references asset-registry.ts
    assetType: AssetCategory;
    position: { x: number; y: number; z: number };
    rotationY: number; // radians
    scale: { x: number; y: number; z: number };
    metadata?: Record<string, unknown>;
}

export interface RoomSnapshot {
    roomId: string;
    roomType: RoomType;
    layout: RoomLayout;
    assets: PlacedAsset[];
}

// Convenience helpers.
export const DEFAULT_ROOM_DIMENSIONS: RoomDimensions = {
    // 12 ft x 10 ft x 8 ft expressed in meters
    width: 3.6576,
    length: 3.048,
    height: 2.4384,
};

export function buildDefaultLayout(): RoomLayout {
    const { width: W, length: L, height: H } = DEFAULT_ROOM_DIMENSIONS;
    const halfW = W / 2;
    const halfL = L / 2;
    const thickness = 0.1;
    return {
        dimensions: { ...DEFAULT_ROOM_DIMENSIONS },
        walls: [
            // North (z = -halfL)
            { id: "wall-n", start: { x: -halfW, z: -halfL }, end: { x: halfW, z: -halfL }, height: H, thickness },
            // South (z = +halfL)
            { id: "wall-s", start: { x: halfW, z: halfL }, end: { x: -halfW, z: halfL }, height: H, thickness },
            // East (x = +halfW)
            { id: "wall-e", start: { x: halfW, z: -halfL }, end: { x: halfW, z: halfL }, height: H, thickness },
            // West (x = -halfW)
            { id: "wall-w", start: { x: -halfW, z: halfL }, end: { x: -halfW, z: -halfL }, height: H, thickness },
        ],
        camera: { position: [W, H * 1.5, L], target: [0, H / 2, 0] },
        surfaces: { floor: null, ceiling: null },
    };
}
