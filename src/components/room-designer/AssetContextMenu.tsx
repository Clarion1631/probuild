// Stage 3: right-click popover. Mounted once by RoomDesigner, listens to
// store.contextMenu for target + screen-space position. Portals to document.body
// so the canvas stacking context doesn't clip it.
//
// Dismiss: click outside (captured on document) or Escape (handled in
// useAssetSelection.ts — it calls closeContextMenu).

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useRoomStore } from "./hooks/useRoomStore";
import { isHidden, isLocked } from "@/lib/room-designer/asset-view";
import type { PlacedAsset } from "./types";

function newDuplicateId(): string {
    return `temp-${Math.random().toString(36).slice(2, 10)}`;
}

export function AssetContextMenu() {
    const menu = useRoomStore((s) => s.contextMenu);
    const assets = useRoomStore((s) => s.assets);
    const closeContextMenu = useRoomStore((s) => s.closeContextMenu);
    const requestFocusProperties = useRoomStore((s) => s.requestFocusProperties);
    const addAsset = useRoomStore((s) => s.addAsset);
    const removeAsset = useRoomStore((s) => s.removeAsset);
    const setAssetLocked = useRoomStore((s) => s.setAssetLocked);
    const setAssetHidden = useRoomStore((s) => s.setAssetHidden);
    const bringForward = useRoomStore((s) => s.bringForward);
    const sendBackward = useRoomStore((s) => s.sendBackward);
    const clearSelection = useRoomStore((s) => s.clearSelection);
    const gridSize = useRoomStore((s) => s.gridSize);

    const ref = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (!menu) return;
        function onDown(e: MouseEvent) {
            if (!ref.current) return;
            if (!(e.target instanceof Node) || !ref.current.contains(e.target)) {
                closeContextMenu();
            }
        }
        // Listen on mousedown so the first click outside dismisses.
        // Use capture so we run before any target-specific handler.
        document.addEventListener("mousedown", onDown, true);
        return () => document.removeEventListener("mousedown", onDown, true);
    }, [menu, closeContextMenu]);

    if (typeof document === "undefined") return null;
    if (!menu) return null;

    const asset = assets.find((a) => a.id === menu.id);
    if (!asset) return null;

    const locked = isLocked(asset);
    const hidden = isHidden(asset);

    const onDuplicate = () => {
        if (locked) return;
        const dup: PlacedAsset = {
            ...asset,
            id: newDuplicateId(),
            position: {
                x: asset.position.x + gridSize,
                y: asset.position.y,
                z: asset.position.z + gridSize,
            },
        };
        addAsset(dup);
        closeContextMenu();
    };

    const onEdit = () => {
        requestFocusProperties();
        closeContextMenu();
    };

    const onToggleLock = () => {
        setAssetLocked(asset.id, !locked);
        closeContextMenu();
    };

    const onToggleHide = () => {
        setAssetHidden(asset.id, !hidden);
        closeContextMenu();
    };

    const onBringForward = () => {
        bringForward(asset.id);
        closeContextMenu();
    };

    const onSendBackward = () => {
        sendBackward(asset.id);
        closeContextMenu();
    };

    const onDelete = () => {
        if (locked) return;
        removeAsset(asset.id);
        clearSelection();
        closeContextMenu();
    };

    // Clamp to viewport so the menu doesn't overflow the window.
    const menuWidth = 200;
    const menuHeight = 280;
    const vw = typeof window !== "undefined" ? window.innerWidth : 1024;
    const vh = typeof window !== "undefined" ? window.innerHeight : 768;
    const x = Math.min(menu.x, vw - menuWidth - 8);
    const y = Math.min(menu.y, vh - menuHeight - 8);

    return createPortal(
        <div
            ref={ref}
            role="menu"
            className="fixed z-[200] w-[200px] overflow-hidden rounded-md border border-slate-200 bg-white py-1 text-sm shadow-lg"
            style={{ left: x, top: y }}
            onContextMenu={(e) => e.preventDefault()}
        >
            <Item label="Edit Properties" shortcut="G" onClick={onEdit} />
            <Item label="Duplicate" shortcut="Ctrl+D" disabled={locked} onClick={onDuplicate} />
            <Item
                label={locked ? "Unlock Position" : "Lock Position"}
                onClick={onToggleLock}
            />
            <Item
                label={hidden ? "Show" : "Hide"}
                onClick={onToggleHide}
            />
            <Item label="Bring Forward" onClick={onBringForward} />
            <Item label="Send Backward" onClick={onSendBackward} />
            <div className="my-1 h-px bg-slate-100" />
            <Item
                label="Delete"
                shortcut="Del"
                danger
                disabled={locked}
                onClick={onDelete}
            />
        </div>,
        document.body,
    );
}

interface ItemProps {
    label: string;
    shortcut?: string;
    disabled?: boolean;
    danger?: boolean;
    onClick: () => void;
}

function Item({ label, shortcut, disabled, danger, onClick }: ItemProps) {
    return (
        <button
            type="button"
            role="menuitem"
            disabled={disabled}
            onClick={onClick}
            className={
                "flex w-full items-center justify-between px-3 py-1.5 text-left text-sm " +
                (disabled
                    ? "cursor-not-allowed text-slate-300"
                    : danger
                        ? "text-red-600 hover:bg-red-50"
                        : "text-slate-700 hover:bg-slate-100")
            }
        >
            <span>{label}</span>
            {shortcut && <span className="text-[10px] text-slate-400">{shortcut}</span>}
        </button>
    );
}
