// src/lib/room-designer/hdri-presets.ts
//
// Four CC0 HDRI lighting presets for the Room Designer. Files live under
// public/assets/room-designer/hdri/ and are fetched by scripts/download-hdri.ts
// (gitignored — first-time setup: `npm run download-hdri`).
//
// Each preset carries three pieces of information:
//   1. envIntensity          — feeds <Canvas gl.toneMappingExposure> (renderer-level)
//   2. windowLightIntensity  — feeds the per-window directional/point fill lights
//                              in <WindowLights> so sunlight through windows
//                              matches the sky in the HDR
//   3. windowLightColor      — warmth tint of that window light (matches HDR mood)

export type HdriPreset = "interior_warm" | "daylight" | "overcast" | "evening";

export interface HdriMeta {
    key: HdriPreset;
    label: string;
    /** Public path (served from /public). */
    file: string;
    /** 0..2 — exposure multiplier for ACESFilmic tone mapping. */
    envIntensity: number;
    /** 0..2 — scales WindowLights intensity. */
    windowLightIntensity: number;
    /** Hex color of window fill light. */
    windowLightColor: number;
}

export const HDRI_PRESETS: Record<HdriPreset, HdriMeta> = {
    interior_warm: {
        key: "interior_warm",
        label: "Warm Interior",
        file: "/assets/room-designer/hdri/interior_warm.hdr",
        envIntensity: 1.0,
        windowLightIntensity: 0.7,
        windowLightColor: 0xfff4e0,
    },
    daylight: {
        key: "daylight",
        label: "Bright Daylight",
        file: "/assets/room-designer/hdri/photo_studio.hdr",
        envIntensity: 1.3,
        windowLightIntensity: 1.4,
        windowLightColor: 0xfff4e0,
    },
    overcast: {
        key: "overcast",
        label: "Overcast",
        file: "/assets/room-designer/hdri/overcast_sky.hdr",
        envIntensity: 0.9,
        windowLightIntensity: 0.5,
        windowLightColor: 0xeef4ff,
    },
    evening: {
        key: "evening",
        label: "Evening Warm",
        file: "/assets/room-designer/hdri/evening_road.hdr",
        envIntensity: 0.7,
        windowLightIntensity: 1.0,
        windowLightColor: 0xffd9a8,
    },
};

/** Default for new rooms and for rooms whose layoutJson.lighting is absent. */
export const DEFAULT_PRESET: HdriPreset = "interior_warm";

/** Ordered list for UI pickers (labels render in this order). */
export const HDRI_PRESET_ORDER: HdriPreset[] = [
    "interior_warm",
    "daylight",
    "overcast",
    "evening",
];

/** Safe lookup — falls back to the default preset if `key` is unknown. */
export function resolvePreset(key: string | null | undefined): HdriMeta {
    if (key && key in HDRI_PRESETS) return HDRI_PRESETS[key as HdriPreset];
    return HDRI_PRESETS[DEFAULT_PRESET];
}
