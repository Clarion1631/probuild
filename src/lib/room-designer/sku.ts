// Display-only SKU derivation for asset cards. NOT a real part number — the
// Estimate side owns real SKUs. Format: <subcat-initial><W><H><D> in integer
// inches, e.g. base 24"×34.5"×24" → "B342424". Pure function; cached per
// asset.id at module scope so the string is stable across renders.

import type { Asset } from "./asset-registry";

const M_TO_IN = 39.3701;
const cache = new Map<string, string>();

export function deriveSku(asset: Asset): string {
    const cached = cache.get(asset.id);
    if (cached) return cached;
    const source = asset.subcategory || asset.category;
    const prefix = source.charAt(0).toUpperCase() || "X";
    const w = Math.round(asset.dimensions.width * M_TO_IN);
    const h = Math.round(asset.dimensions.height * M_TO_IN);
    const d = Math.round(asset.dimensions.depth * M_TO_IN);
    const sku = `${prefix}${w}${h}${d}`;
    cache.set(asset.id, sku);
    return sku;
}
