// Room Designer — core types.
//
// FUTURE MOBILE: all fields here are portable to React Native / Expo.
// Do not import from `next/*` or browser-only APIs in this file.
// FUTURE AR: positions use real-world meters so they map directly onto ARKit/ARCore anchors.
// FUTURE LIDAR: RoomLayout is designed to be populated from Apple RoomPlan USDZ output.

import type { HdriPreset } from "@/lib/room-designer/hdri-presets";

export type AssetCategory = "cabinet" | "appliance" | "fixture" | "window" | "door" | "lighting" | "plants";

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
    // Which RoomSurface slot this wall occupies. Present on the 4 cardinal
    // walls produced by `buildDefaultLayout`. Older persisted walls without
    // it fall back to the id → surface map in materials/SurfaceSelector.
    surface?: RoomSurface;
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

export interface RoomLighting {
    /** HDRI preset key; absent = use DEFAULT_PRESET. */
    hdriPreset: HdriPreset;
}

export interface RoomLayout {
    dimensions: RoomDimensions;
    walls: Wall[];
    camera: CameraState;
    surfaces: Partial<Record<RoomSurface, string | null>>; // material id per surface (Stage 2+)
    // Stage 4: HDRI lighting preset. Absent on older rooms — callers must
    // fall back to DEFAULT_PRESET when reading.
    lighting?: RoomLighting;
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

// ─────────────── Stage 2: per-category metadata shapes ───────────────
// These plug into the existing PlacedAsset.metadata slot — Prisma's
// RoomAsset.metadata is already Json?, so no migration is needed.

export type CabinetDoorStyle = "shaker" | "flat" | "raised" | "glass" | "open";
export type CabinetFinishPreset =
    | "white"
    | "gray"
    | "navy"
    | "green"
    | "wood"
    | "walnut"
    | "two-tone"
    | "black"
    | "cream";
export type CabinetHardware = "none" | "bar-pull" | "cup-pull" | "knob" | "edge-pull";
export type CabinetInterior = "standard" | "drawer-org" | "pullout" | "lazy-susan" | "trash";

export interface CabinetMeta {
    width?: number;
    height?: number;
    depth?: number; // meters, overrides registry
    doorStyle?: CabinetDoorStyle;
    finish?: CabinetFinishPreset | string; // string = custom hex
    hardware?: CabinetHardware;
    interior?: CabinetInterior;
}

export type ApplianceFinish = "stainless" | "black-ss" | "white" | "panel-ready";
export interface ApplianceMeta {
    brand?: string;
    finish?: ApplianceFinish;
}

export type FixtureFinish = "chrome" | "brushed-nickel" | "matte-black" | "oil-bronze" | "brass";
export interface FixtureMeta {
    finish?: FixtureFinish;
}

// ─────────────── Stage 3: view-state per asset ───────────────
// Lives inside `PlacedAsset.metadata.view`. Prisma's RoomAsset.metadata is
// already Json?, so no DB migration is needed. Do NOT promote any of these
// to top-level PlacedAsset fields — Prisma silently drops unknown top-level
// fields on insert, which would reset hide/lock/rename on every page load.
export interface AssetViewMeta {
    hidden?: boolean;
    locked?: boolean;
    label?: string; // user-renamed label; falls back to registry.name
}

// UI-only — not persisted. Drives the transform gizmo mode.
export type ToolMode = "translate" | "rotate" | "scale";

// Camera preset buttons (plus "orbit" for user-controlled perspective).
export type CameraPreset = "top" | "front" | "back" | "left" | "right" | "iso";

export type MetadataSubkey = "cabinet" | "appliance" | "fixture" | "view";

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
            { id: "wall-n", start: { x: -halfW, z: -halfL }, end: { x: halfW, z: -halfL }, height: H, thickness, surface: "wall-north" },
            // South (z = +halfL)
            { id: "wall-s", start: { x: halfW, z: halfL }, end: { x: -halfW, z: halfL }, height: H, thickness, surface: "wall-south" },
            // East (x = +halfW)
            { id: "wall-e", start: { x: halfW, z: -halfL }, end: { x: halfW, z: halfL }, height: H, thickness, surface: "wall-east" },
            // West (x = -halfW)
            { id: "wall-w", start: { x: -halfW, z: halfL }, end: { x: -halfW, z: -halfL }, height: H, thickness, surface: "wall-west" },
        ],
        camera: { position: [W, H * 1.5, L], target: [0, H / 2, 0] },
        surfaces: { floor: null, ceiling: null },
    };
}
