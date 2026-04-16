// Keyboard shortcut handler for the Room Designer. Mounted once by
// RoomDesigner.tsx. Replaces the inline Delete-key useEffect from Stage 0.
//
// All handlers are no-ops when the focused element is a text input so users
// can type in WallBuilder / PropertiesPanel freely. Escape is the single
// exception — it always cancels placement regardless of focus.
//
// Stage 3 additions:
//   - Multi-select aware: arrow nudge, delete, and duplicate operate on EVERY
//     selected asset. Batch mutations go through `updateAssets` so one Ctrl+Z
//     reverts the whole operation.
//   - Skips locked assets silently (mixed selection applies to unlocked only).
//   - `L` toggles LayersPanel. `M` toggles measurement overlay. `1/2/3` switch
//     transform gizmo mode (Move/Rotate/Scale).

import { useEffect } from "react";
import { useRoomStore } from "./useRoomStore";
import { isLocked } from "@/lib/room-designer/asset-view";
import type { PlacedAsset } from "@/components/room-designer/types";

const NUDGE_SMALL = 0.0254;  // 1 inch in meters
const NUDGE_LARGE = 0.1524;  // 6 inches in meters
const ROTATE_LARGE = Math.PI / 2;  // 90°
const ROTATE_SMALL = Math.PI / 4;  // 45°

function newDuplicateId(): string {
    return `temp-${Math.random().toString(36).slice(2, 10)}`;
}

function isTypingTarget(target: EventTarget | null): boolean {
    if (!target || !(target instanceof HTMLElement)) return false;
    const tag = target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if (target.isContentEditable) return true;
    return false;
}

export function useAssetSelection() {
    useEffect(() => {
        function onKey(e: KeyboardEvent) {
            const store = useRoomStore.getState();

            // Escape: cancel placement OR close context menu OR deselect.
            // Works regardless of focus.
            if (e.key === "Escape") {
                if (store.placingAsset) {
                    e.preventDefault();
                    store.cancelPlacing();
                    return;
                }
                if (store.contextMenu) {
                    e.preventDefault();
                    store.closeContextMenu();
                    return;
                }
                if (store.selectedAssetIds.length > 0) {
                    e.preventDefault();
                    store.clearSelection();
                    return;
                }
                return;
            }

            // Everything else — skip when typing.
            if (isTypingTarget(e.target)) return;

            // `?` — Shortcut legend. Uses `e.key === "?"` which already
            // accounts for Shift on US layouts; also accept Shift+/ on
            // layouts where `?` doesn't bubble as a plain key.
            if (e.key === "?" || (e.shiftKey && e.key === "/")) {
                e.preventDefault();
                store.openShortcutLegend();
                return;
            }

            // Global panel toggles (no selection required).
            if (e.key === "l" || e.key === "L") {
                e.preventDefault();
                store.setShowLayers(!store.showLayers);
                return;
            }
            if (e.key === "m" || e.key === "M") {
                e.preventDefault();
                store.setShowMeasurements(!store.showMeasurements);
                return;
            }
            if (e.key === "v" || e.key === "V") {
                e.preventDefault();
                store.setViewMode(store.viewMode === "2d" ? "3d" : "2d");
                return;
            }
            if (e.key === "b" || e.key === "B") {
                e.preventDefault();
                store.togglePreviewMode();
                return;
            }
            // Ctrl+S — force save. Dispatched as a CustomEvent so the
            // RoomToolbar (which owns the save() closure) can listen without
            // leaking its state here.
            if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
                e.preventDefault();
                window.dispatchEvent(new CustomEvent("room-designer:force-save"));
                return;
            }
            // Tool mode switches.
            if (e.key === "1") {
                e.preventDefault();
                store.setToolMode("translate");
                return;
            }
            if (e.key === "2") {
                e.preventDefault();
                store.setToolMode("rotate");
                return;
            }
            if (e.key === "3") {
                e.preventDefault();
                store.setToolMode("scale");
                return;
            }

            const ids = store.selectedAssetIds;
            if (ids.length === 0) return;

            // Resolve the set of selected, unlocked assets once.
            const assetMap = new Map(store.assets.map((a) => [a.id, a] as const));
            const targets: PlacedAsset[] = ids
                .map((id) => assetMap.get(id))
                .filter((a): a is PlacedAsset => !!a && !isLocked(a));
            if (targets.length === 0) return;

            const step = e.shiftKey ? NUDGE_LARGE : NUDGE_SMALL;

            // Delete / Backspace — remove every unlocked selected asset.
            if (e.key === "Delete" || e.key === "Backspace") {
                e.preventDefault();
                for (const a of targets) store.removeAsset(a.id);
                store.clearSelection();
                return;
            }

            // Ctrl/Cmd + D — duplicate each selected asset (offset by grid size).
            if ((e.ctrlKey || e.metaKey) && (e.key === "d" || e.key === "D")) {
                e.preventDefault();
                const g = store.gridSize;
                const newIds: string[] = [];
                for (const a of targets) {
                    const dup: PlacedAsset = {
                        ...a,
                        id: newDuplicateId(),
                        position: { x: a.position.x + g, y: a.position.y, z: a.position.z + g },
                    };
                    store.addAsset(dup);
                    newIds.push(dup.id);
                }
                store.selectMultiple(newIds);
                return;
            }

            // Arrow keys — batch nudge.
            const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
            const dz = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
            if (dx !== 0 || dz !== 0) {
                e.preventDefault();
                store.updateAssets(
                    targets.map((a) => ({
                        id: a.id,
                        patch: { position: { ...a.position, x: a.position.x + dx, z: a.position.z + dz } },
                    })),
                );
                return;
            }

            // R — rotate each by 90° (Shift+R for 45°).
            if (e.key === "r" || e.key === "R") {
                e.preventDefault();
                const delta = e.shiftKey ? ROTATE_SMALL : ROTATE_LARGE;
                store.updateAssets(
                    targets.map((a) => ({ id: a.id, patch: { rotationY: a.rotationY + delta } })),
                );
                return;
            }

            // G — focus properties panel (only meaningful for single-select).
            if (e.key === "g" || e.key === "G") {
                e.preventDefault();
                store.requestFocusProperties();
                return;
            }
        }

        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);
}
