// Counter-run detection — pure function for Stage 3 to consume.
//
// A "run" is two or more base cabinets whose resolved AABBs touch edge-to-edge
// along the same axis (X or Z), forming a contiguous counter surface.
//
// Stage 2: this function EXISTS but is not called. Stage 3 will import it
// post-placement to offer "Apply countertop" once a material picker is wired.
//
// Base cabinet subcategories per the registry are "base" | "island" | "corner".
// The 4-drawer base uses subcategory "base" (NOT "drawer") — do not extend
// this list without grepping asset-registry.ts first.

import type { PlacedAsset } from "@/components/room-designer/types";
import type { Asset } from "@/lib/room-designer/asset-registry";
import { resolveDimensions } from "@/lib/room-designer/asset-resolve";

const BASE_CABINET_SUBCATEGORIES = new Set(["base", "island", "corner"]);
const EDGE_TOUCH_TOLERANCE = 0.05; // meters (~2") — allows for minor placement drift

function isBaseCabinet(placed: PlacedAsset, registry: Asset | undefined): boolean {
    if (!registry || placed.assetType !== "cabinet") return false;
    return BASE_CABINET_SUBCATEGORIES.has(registry.subcategory);
}

interface Footprint {
    id: string;
    x1: number; x2: number;
    z1: number; z2: number;
}

function footprint(placed: PlacedAsset, registry: Asset): Footprint {
    const { width, depth } = resolveDimensions(placed, registry);
    return {
        id: placed.id,
        x1: placed.position.x - width / 2,
        x2: placed.position.x + width / 2,
        z1: placed.position.z - depth / 2,
        z2: placed.position.z + depth / 2,
    };
}

function touchesX(a: Footprint, b: Footprint): boolean {
    // Adjacent along X: one's right edge meets the other's left edge, Z ranges overlap.
    const xTouch =
        Math.abs(a.x2 - b.x1) < EDGE_TOUCH_TOLERANCE ||
        Math.abs(b.x2 - a.x1) < EDGE_TOUCH_TOLERANCE;
    const zOverlap = Math.min(a.z2, b.z2) - Math.max(a.z1, b.z1) > 0;
    return xTouch && zOverlap;
}

function touchesZ(a: Footprint, b: Footprint): boolean {
    const zTouch =
        Math.abs(a.z2 - b.z1) < EDGE_TOUCH_TOLERANCE ||
        Math.abs(b.z2 - a.z1) < EDGE_TOUCH_TOLERANCE;
    const xOverlap = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1) > 0;
    return zTouch && xOverlap;
}

export function detectCounterRuns(
    assets: PlacedAsset[],
    getRegistry: (id: string) => Asset | undefined,
): string[][] {
    const bases: Footprint[] = [];
    for (const a of assets) {
        const reg = getRegistry(a.assetId);
        if (!isBaseCabinet(a, reg)) continue;
        if (reg) bases.push(footprint(a, reg));
    }

    // Union-find over adjacency edges.
    const parent = new Map<string, string>();
    bases.forEach((b) => parent.set(b.id, b.id));
    const find = (x: string): string => {
        const p = parent.get(x)!;
        if (p === x) return x;
        const r = find(p);
        parent.set(x, r);
        return r;
    };
    const union = (x: string, y: string) => {
        const rx = find(x), ry = find(y);
        if (rx !== ry) parent.set(rx, ry);
    };

    for (let i = 0; i < bases.length; i++) {
        for (let j = i + 1; j < bases.length; j++) {
            if (touchesX(bases[i], bases[j]) || touchesZ(bases[i], bases[j])) {
                union(bases[i].id, bases[j].id);
            }
        }
    }

    const groups = new Map<string, string[]>();
    for (const b of bases) {
        const root = find(b.id);
        const list = groups.get(root) ?? [];
        list.push(b.id);
        groups.set(root, list);
    }

    // A "run" requires at least 2 cabinets. Singleton groups are not runs.
    return Array.from(groups.values()).filter((g) => g.length >= 2);
}
