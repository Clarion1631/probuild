// Hover-preview state for the materials UI.
//
// Hovering a swatch must NOT touch the Zustand store: doing so would flood
// undo history and mark the room dirty on every mouse-move. So we keep a
// tiny separate Zustand store just for the preview id. It is read by
// canvas meshes through the SurfaceMaterial.previewMaterialId prop and
// written by MaterialLibrary on mouseenter/leave.

import { create } from "zustand";
import { useRoomStore } from "@/components/room-designer/hooks/useRoomStore";
import type { RoomSurface } from "@/components/room-designer/types";

interface HoverPreviewStore {
    /** Material id currently being previewed (null = no hover). */
    hoveredMaterialId: string | null;
    /** Which surface to apply the preview to. Null = preview is inert. */
    hoveredTarget: RoomSurface | null;
    setHover: (target: RoomSurface | null, materialId: string | null) => void;
    clearHover: () => void;
}

export const useHoverPreview = create<HoverPreviewStore>((set) => ({
    hoveredMaterialId: null,
    hoveredTarget: null,
    setHover: (hoveredTarget, hoveredMaterialId) => set({ hoveredTarget, hoveredMaterialId }),
    clearHover: () => set({ hoveredTarget: null, hoveredMaterialId: null }),
}));

/**
 * Reads the persisted material id for a surface from `layout.surfaces`,
 * then applies the live hover override if one is active for THIS surface.
 * Returns the id the renderer should display right now.
 */
export function useResolvedSurfaceMaterial(surface: RoomSurface): string | null {
    const persisted = useRoomStore((s) => s.layout.surfaces[surface] ?? null);
    const hoverTarget = useHoverPreview((s) => s.hoveredTarget);
    const hoverId = useHoverPreview((s) => s.hoveredMaterialId);
    if (hoverTarget === surface && hoverId !== null) return hoverId;
    return persisted;
}
