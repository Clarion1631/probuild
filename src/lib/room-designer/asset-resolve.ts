// Resolve the effective dimensions and display color for a PlacedAsset.
//
// Stage 2 configurators write per-category overrides into PlacedAsset.metadata.
// These helpers read the overrides if present, else fall back to the registry
// entry. AssetNode (the renderer) and useAssetPlacement (collision/snap) both
// call through here, so geometry and physics stay in sync.
//
// Stage 1 will additionally return a GLTF src path; those changes are contained
// to AssetNode, not this file.

import type { Asset } from "@/lib/room-designer/asset-registry";
import { CATEGORY_COLORS } from "@/lib/room-designer/asset-registry";
import type {
    ApplianceFinish,
    ApplianceMeta,
    CabinetFinishPreset,
    CabinetMeta,
    FixtureFinish,
    FixtureMeta,
    PlacedAsset,
} from "@/components/room-designer/types";

// Lookup tables for every finish enum value. Keep these exported so configurator
// swatches render with identical colors to the 3D preview.
export const CABINET_FINISH_COLORS: Record<CabinetFinishPreset, string> = {
    white: "#f5f1e8",
    gray: "#8c8f94",
    navy: "#1f2d4f",
    green: "#3c5a48",
    wood: "#c9a06b",
    walnut: "#5a3e2b",
    "two-tone": "#d8cdb8",
    black: "#1a1a1a",
    cream: "#ecdcbf",
};

export const APPLIANCE_FINISH_COLORS: Record<ApplianceFinish, string> = {
    stainless: "#c5c8cc",
    "black-ss": "#2a2a2d",
    white: "#f2f2f2",
    "panel-ready": "#c9a06b", // panel-ready matches adjacent cabinet wood tone
};

export const FIXTURE_FINISH_COLORS: Record<FixtureFinish, string> = {
    chrome: "#cfd3d7",
    "brushed-nickel": "#a8a29b",
    "matte-black": "#1d1d1f",
    "oil-bronze": "#5c4538",
    brass: "#c9a548",
};

export interface ResolvedDimensions {
    width: number;
    height: number;
    depth: number;
}

// Narrow the metadata blob into its typed sub-shape. Returns {} if absent.
function readMeta<T>(placed: PlacedAsset, key: "cabinet" | "appliance" | "fixture"): Partial<T> {
    const m = placed.metadata as Record<string, unknown> | undefined;
    const sub = m?.[key];
    if (!sub || typeof sub !== "object") return {};
    return sub as Partial<T>;
}

export function resolveDimensions(placed: PlacedAsset, registry: Asset): ResolvedDimensions {
    if (placed.assetType === "cabinet") {
        const cab = readMeta<CabinetMeta>(placed, "cabinet");
        return {
            width: cab.width ?? registry.dimensions.width,
            height: cab.height ?? registry.dimensions.height,
            depth: cab.depth ?? registry.dimensions.depth,
        };
    }
    return { ...registry.dimensions };
}

// Hex color for the mesh material. Validates custom color strings defensively —
// if the user types garbage into the color picker, fall back to the preset map
// or the category default rather than crashing react-three-fiber.
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function resolveColor(placed: PlacedAsset, _registry: Asset): string {
    const category = placed.assetType;

    if (category === "cabinet") {
        const cab = readMeta<CabinetMeta>(placed, "cabinet");
        if (cab.finish) {
            if (HEX_RE.test(cab.finish)) return cab.finish;
            const preset = CABINET_FINISH_COLORS[cab.finish as CabinetFinishPreset];
            if (preset) return preset;
        }
    } else if (category === "appliance") {
        const app = readMeta<ApplianceMeta>(placed, "appliance");
        if (app.finish && APPLIANCE_FINISH_COLORS[app.finish]) {
            return APPLIANCE_FINISH_COLORS[app.finish];
        }
    } else if (category === "fixture") {
        const fix = readMeta<FixtureMeta>(placed, "fixture");
        if (fix.finish && FIXTURE_FINISH_COLORS[fix.finish]) {
            return FIXTURE_FINISH_COLORS[fix.finish];
        }
    }

    return CATEGORY_COLORS[category];
}
