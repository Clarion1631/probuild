// Stage 3: Layers panel. Shown/hidden by `store.showLayers` (L key toggle).
// Mounted as a DOM sibling of the canvas — not inside <Canvas> — so HTML5
// drag events aren't swallowed by the WebGL surface. Each row:
//   - category icon + editable label (double-click to rename)
//   - eye toggle (setAssetHidden)
//   - lock toggle (setAssetLocked)
//   - row click selects the asset
//   - up/down arrows reorder (drag-to-reorder is intentionally deferred —
//     HTML5 DnD over a WebGL surface is finicky in practice)

import { useState } from "react";
import { useRoomStore } from "./hooks/useRoomStore";
import { getAsset } from "@/lib/room-designer/asset-registry";
import { isHidden, isLocked, getLabel } from "@/lib/room-designer/asset-view";
import type { AssetCategory, PlacedAsset } from "./types";

const CATEGORY_ICON: Record<AssetCategory, string> = {
    cabinet: "▦",
    appliance: "◨",
    fixture: "◉",
    window: "▣",
    door: "▯",
    lighting: "✦",
    plants: "❦",
};

export function LayersPanel() {
    const show = useRoomStore((s) => s.showLayers);
    const setShow = useRoomStore((s) => s.setShowLayers);
    const assets = useRoomStore((s) => s.assets);
    const selectedIds = useRoomStore((s) => s.selectedAssetIds);
    const selectAsset = useRoomStore((s) => s.selectAsset);
    const toggleAssetInSelection = useRoomStore((s) => s.toggleAssetInSelection);
    const setAssetHidden = useRoomStore((s) => s.setAssetHidden);
    const setAssetLocked = useRoomStore((s) => s.setAssetLocked);
    const renameAsset = useRoomStore((s) => s.renameAsset);
    const bringForward = useRoomStore((s) => s.bringForward);
    const sendBackward = useRoomStore((s) => s.sendBackward);

    if (!show) return null;

    // Top of panel = front-most; internal array order = back→front.
    const rows = [...assets].reverse();

    return (
        <aside className="flex h-full w-64 shrink-0 flex-col border-r border-slate-200 bg-white">
            <header className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Layers
                </h3>
                <button
                    type="button"
                    title="Close (L)"
                    onClick={() => setShow(false)}
                    className="rounded px-2 py-0.5 text-xs text-slate-500 hover:bg-slate-100"
                >
                    ×
                </button>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto">
                {rows.length === 0 && (
                    <p className="p-3 text-xs text-slate-400">
                        Place an asset to see it here.
                    </p>
                )}
                {rows.map((asset) => (
                    <LayerRow
                        key={asset.id}
                        asset={asset}
                        selected={selectedIds.includes(asset.id)}
                        onSelect={(shift) => {
                            if (shift) toggleAssetInSelection(asset.id);
                            else selectAsset(asset.id);
                        }}
                        onToggleHide={() => setAssetHidden(asset.id, !isHidden(asset))}
                        onToggleLock={() => setAssetLocked(asset.id, !isLocked(asset))}
                        onRename={(label) => renameAsset(asset.id, label)}
                        onBringForward={() => bringForward(asset.id)}
                        onSendBackward={() => sendBackward(asset.id)}
                    />
                ))}
            </div>
        </aside>
    );
}

interface LayerRowProps {
    asset: PlacedAsset;
    selected: boolean;
    onSelect: (shift: boolean) => void;
    onToggleHide: () => void;
    onToggleLock: () => void;
    onRename: (label: string) => void;
    onBringForward: () => void;
    onSendBackward: () => void;
}

function LayerRow({
    asset,
    selected,
    onSelect,
    onToggleHide,
    onToggleLock,
    onRename,
    onBringForward,
    onSendBackward,
}: LayerRowProps) {
    const registry = getAsset(asset.assetId) ?? null;
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState("");
    const hidden = isHidden(asset);
    const locked = isLocked(asset);
    const label = getLabel(asset, registry);
    const icon = CATEGORY_ICON[asset.assetType] ?? "·";

    const commit = () => {
        setEditing(false);
        if (draft.trim().length > 0) onRename(draft);
    };

    return (
        <div
            className={
                "group flex items-center gap-1.5 border-b border-slate-50 px-2 py-1.5 text-xs " +
                (selected ? "bg-blue-50" : "hover:bg-slate-50")
            }
            onClick={(e) => onSelect(e.shiftKey)}
        >
            <span className="w-4 shrink-0 text-center text-slate-500">{icon}</span>

            {editing ? (
                <input
                    autoFocus
                    type="text"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commit}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") commit();
                        if (e.key === "Escape") setEditing(false);
                    }}
                    onClick={(e) => e.stopPropagation()}
                    className="min-w-0 flex-1 rounded border border-slate-300 bg-white px-1 py-0.5 text-xs outline-none focus:border-blue-400"
                />
            ) : (
                <span
                    className={"min-w-0 flex-1 truncate " + (hidden ? "text-slate-400 line-through" : "text-slate-800")}
                    onDoubleClick={(e) => {
                        e.stopPropagation();
                        setDraft(label);
                        setEditing(true);
                    }}
                    title="Double-click to rename"
                >
                    {label}
                </span>
            )}

            <IconBtn
                title="Send backward"
                onClick={(e) => { e.stopPropagation(); onSendBackward(); }}
            >▼</IconBtn>
            <IconBtn
                title="Bring forward"
                onClick={(e) => { e.stopPropagation(); onBringForward(); }}
            >▲</IconBtn>
            <IconBtn
                title={hidden ? "Show" : "Hide"}
                onClick={(e) => { e.stopPropagation(); onToggleHide(); }}
                active={hidden}
            >
                {hidden ? "🙈" : "👁"}
            </IconBtn>
            <IconBtn
                title={locked ? "Unlock" : "Lock"}
                onClick={(e) => { e.stopPropagation(); onToggleLock(); }}
                active={locked}
            >
                {locked ? "🔒" : "🔓"}
            </IconBtn>
        </div>
    );
}

function IconBtn({
    title, onClick, active, children,
}: {
    title: string;
    onClick: (e: React.MouseEvent) => void;
    active?: boolean;
    children: React.ReactNode;
}) {
    return (
        <button
            type="button"
            title={title}
            onClick={onClick}
            className={
                "rounded px-1 py-0.5 text-[11px] leading-none transition " +
                (active
                    ? "bg-amber-100 text-amber-800"
                    : "text-slate-500 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto hover:bg-slate-100")
            }
        >
            {children}
        </button>
    );
}
