// /api/assets?category=cabinet — returns entries from the in-code asset registry.
// The registry is a static TS file, not a DB table, so this route is mostly a
// convenience for client components that don't want to import the whole list.

import { NextResponse } from "next/server";
import { ASSET_REGISTRY, ASSETS_BY_CATEGORY } from "@/lib/room-designer/asset-registry";
import type { AssetCategory } from "@/components/room-designer/types";

export const dynamic = "force-static";

export async function GET(req: Request) {
    const { searchParams } = new URL(req.url);
    const category = searchParams.get("category") as AssetCategory | null;
    if (category && Object.prototype.hasOwnProperty.call(ASSETS_BY_CATEGORY, category)) {
        return NextResponse.json(ASSETS_BY_CATEGORY[category]);
    }
    return NextResponse.json(ASSET_REGISTRY);
}
