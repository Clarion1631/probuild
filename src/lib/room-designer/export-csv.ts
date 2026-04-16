// CSV materials list for contractors who want the bill-of-materials in
// Excel/Sheets. Columns: Category, Item, Finish, Width, Height, Depth, Qty, Notes.
//
// Identical rows (same assetId + finish + notes) are collapsed and their qty
// summed so the output is a true count-by-SKU, not a flat placement log.
// Dimensions are emitted in inches (2 decimals) because every US contractor
// in our sales pipeline speaks imperial.

import type { PlacedAsset } from "@/components/room-designer/types";
import { ASSET_REGISTRY, getAsset, type Asset } from "./asset-registry";

interface CsvRow {
    category: string;
    item: string;
    finish: string;
    width: string;   // inches, 2dp
    height: string;  // inches, 2dp
    depth: string;   // inches, 2dp
    qty: number;
    notes: string;
}

const HEADER = ["Category", "Item", "Finish", "Width", "Height", "Depth", "Qty", "Notes"];

/**
 * Build a CSV string from the given placed assets. Hidden assets (view.hidden
 * true) are excluded — they were deliberately taken out of the scene by the
 * designer, so they shouldn't show up in the materials list.
 */
export function buildMaterialsCsv(
    assets: PlacedAsset[],
    registry: Asset[] = ASSET_REGISTRY,
): string {
    const rows = aggregate(assets, registry);
    const body = rows
        .map((r) =>
            [r.category, r.item, r.finish, r.width, r.height, r.depth, String(r.qty), r.notes]
                .map(csvEscape)
                .join(","),
        )
        .join("\n");
    return `${HEADER.map(csvEscape).join(",")}\n${body}\n`;
}

function aggregate(assets: PlacedAsset[], registry: Asset[]): CsvRow[] {
    const byKey = new Map<string, CsvRow>();
    for (const a of assets) {
        const view = (a.metadata as { view?: { hidden?: boolean } } | undefined)?.view;
        if (view?.hidden) continue;

        const def = registry.find((d) => d.id === a.assetId) ?? getAsset(a.assetId);
        if (!def) continue;

        const finish = readFinish(a);
        const notes = readNotes(a);
        const key = `${a.assetId}::${finish}::${notes}`;
        const existing = byKey.get(key);
        if (existing) {
            existing.qty += 1;
            continue;
        }
        byKey.set(key, {
            category: capitalize(def.category),
            item: def.name,
            finish,
            width: metersToInches(def.dimensions.width),
            height: metersToInches(def.dimensions.height),
            depth: metersToInches(def.dimensions.depth),
            qty: 1,
            notes,
        });
    }
    return Array.from(byKey.values()).sort((a, b) => {
        if (a.category !== b.category) return a.category.localeCompare(b.category);
        return a.item.localeCompare(b.item);
    });
}

function readFinish(a: PlacedAsset): string {
    const m = a.metadata as
        | { cabinet?: { finish?: string }; appliance?: { finish?: string }; fixture?: { finish?: string } }
        | undefined;
    return m?.cabinet?.finish || m?.appliance?.finish || m?.fixture?.finish || "";
}

function readNotes(a: PlacedAsset): string {
    const m = a.metadata as { notes?: string } | undefined;
    return typeof m?.notes === "string" ? m.notes : "";
}

function metersToInches(m: number): string {
    return (m / 0.0254).toFixed(2);
}

function capitalize(s: string): string {
    return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

/**
 * RFC 4180 style cell escape. Double-quote any cell that contains a comma,
 * quote, or newline; escape internal quotes by doubling them.
 */
function csvEscape(v: string): string {
    if (/[",\r\n]/.test(v)) {
        return `"${v.replace(/"/g, '""')}"`;
    }
    return v;
}
