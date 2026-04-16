// 2-column grid of AssetCard tiles. Parent (AssetPanel) supplies the already-
// filtered list; this component is stateless except for the scroll window.
//
// Windowing: AssetGrid owns its own scroll container and renders only the rows
// currently in view (plus a small overscan) by measuring `scrollTop`. With the
// Stage 0 asset count (~40 items) this is a no-op optimization — we render all
// rows — but the structure scales cleanly when Stage 2+ ships hundreds of
// GLB-backed assets without requiring `react-window` or other new deps.

import { useEffect, useRef, useState } from "react";
import type { Asset } from "@/lib/room-designer/asset-registry";
import { AssetCard } from "./AssetCard";

interface AssetGridProps {
    items: Asset[];
    activeAssetId: string | null;
    onSelect: (asset: Asset) => void;
}

const COLS = 2;
// AssetCard: h-16 image (64) + p-1.5 padding (12) + two lines of text (~30) +
// gap-2 (8). Close enough to reserve slot height without jitter.
const ROW_HEIGHT = 118;
const OVERSCAN_ROWS = 3;
// Below this threshold windowing overhead > savings — render everything.
const WINDOW_THRESHOLD = 60;

export function AssetGrid({ items, activeAssetId, onSelect }: AssetGridProps) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const [scrollTop, setScrollTop] = useState(0);
    const [viewportHeight, setViewportHeight] = useState(0);

    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        setViewportHeight(el.clientHeight);
        const onScroll = () => setScrollTop(el.scrollTop);
        el.addEventListener("scroll", onScroll, { passive: true });
        const ro = new ResizeObserver(() => setViewportHeight(el.clientHeight));
        ro.observe(el);
        return () => {
            el.removeEventListener("scroll", onScroll);
            ro.disconnect();
        };
    }, []);

    if (items.length === 0) {
        return (
            <div ref={scrollRef} className="flex-1 overflow-y-auto">
                <div className="py-8 text-center text-xs text-slate-400">No assets match.</div>
            </div>
        );
    }

    const rowCount = Math.ceil(items.length / COLS);
    const windowed = items.length >= WINDOW_THRESHOLD && viewportHeight > 0;

    let startRow = 0;
    let endRow = rowCount;
    if (windowed) {
        startRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN_ROWS);
        endRow = Math.min(rowCount, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN_ROWS);
    }
    const visible = items.slice(startRow * COLS, endRow * COLS);
    const topPad = windowed ? startRow * ROW_HEIGHT : 0;
    const bottomPad = windowed ? (rowCount - endRow) * ROW_HEIGHT : 0;

    return (
        <div ref={scrollRef} className="flex-1 overflow-y-auto">
            {topPad > 0 && <div style={{ height: topPad }} aria-hidden />}
            <div className="grid grid-cols-2 gap-2">
                {visible.map((a) => (
                    <AssetCard
                        key={a.id}
                        asset={a}
                        active={a.id === activeAssetId}
                        onSelect={onSelect}
                    />
                ))}
            </div>
            {bottomPad > 0 && <div style={{ height: bottomPad }} aria-hidden />}
        </div>
    );
}
