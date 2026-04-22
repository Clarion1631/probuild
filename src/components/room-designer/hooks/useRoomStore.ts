// Zustand store for a single Room Designer session.
//
// FUTURE MOBILE: Zustand works unchanged on React Native. No browser APIs here.

import { create } from "zustand";
import type {
    CameraPreset,
    MetadataSubkey,
    PlacedAsset,
    RoomLayout,
    RoomSnapshot,
    RoomSurface,
    RoomType,
    ToolMode,
    ViewMode,
} from "@/components/room-designer/types";
import type { Asset } from "@/lib/room-designer/asset-registry";
import { isLocked } from "@/lib/room-designer/asset-view";
import { DEFAULT_PRESET, type HdriPreset } from "@/lib/room-designer/hdri-presets";
import type * as THREE from "three";
import type { SnapLine } from "@/components/room-designer/canvas/AssetGhost";

/**
 * Non-serializable handles into the live R3F scene. Populated on Canvas mount
 * by <SceneRefBridge /> and consumed imperatively by export buttons. These
 * MUST NOT be subscribed-to with Zustand selectors — reading them via
 * `getState().canvasRefs` on button click keeps them out of render loops.
 */
export interface CanvasRefs {
    gl: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.Camera;
}

/** Design view shows placed assets; Empty view hides them (walls/materials remain). */
export type PreviewMode = "design" | "empty";

type PastSnapshot = { layout: RoomLayout; assets: PlacedAsset[] };

export interface RoomStoreState {
    // session identity
    roomId: string;
    roomType: RoomType;

    // scene
    layout: RoomLayout;
    assets: PlacedAsset[];

    // Stage 3: multi-select. Order matters for "first / last" in distribute.
    // When empty, no asset is selected. The `useSelectedAssetId()` selector
    // helper returns the primary (first) id for single-selection call sites.
    selectedAssetIds: string[];

    // Stage 2: which RoomSurface the user is currently editing in MaterialLibrary.
    // Mutually exclusive with selectedAssetIds — setting one clears the other.
    activeSurface: RoomSurface | null;

    // UI
    viewMode: ViewMode;
    isDragging: boolean;
    draggingAssetId: string | null;

    // Stage 3: transform gizmo mode ("translate" | "rotate" | "scale").
    toolMode: ToolMode;

    // Stage 3: right-click context menu target + screen-space position.
    contextMenu: { id: string; x: number; y: number } | null;

    // Stage 3: panel visibility (L / M keys).
    showLayers: boolean;
    showMeasurements: boolean;

    // Stage 3: camera preset ("orbit" = free-look 3D; presets animate on change).
    cameraPreset: CameraPreset | "orbit";

    // Stage 4: production toggles. These are VIEW-ONLY — not in history,
    // not autosaved, except hdriPreset which rides through layout.lighting.
    effectsEnabled: boolean;              // SSAO + Bloom
    previewMode: PreviewMode;             // Before/After toggle
    shortcutLegendOpen: boolean;          // ? modal
    onboardingActive: boolean;            // 4-step coach; derived from localStorage on mount

    // Stage 4: non-serializable scene handles (for imperative PNG/PDF export).
    canvasRefs: CanvasRefs | null;

    // transient placement state (NOT history, NOT autosaved)
    placingAsset: Asset | null;
    snapToGrid: boolean;
    gridSize: number; // meters; default 0.1524 (6")
    focusPropertiesTick: number;
    transformSnapLines: SnapLine[];

    // persistence
    dirty: boolean;
    lastSavedAt: number | null;

    // history (50-step ring)
    past: PastSnapshot[];
    future: PastSnapshot[];

    // actions — scene
    loadSnapshot: (snap: RoomSnapshot) => void;
    setLayout: (layout: RoomLayout) => void;
    addAsset: (asset: PlacedAsset) => void;
    updateAsset: (id: string, patch: Partial<PlacedAsset>) => void;
    // Stage 3 batch update — one history entry for N assets (alignment/distribute).
    // Filters out locked assets (mixed selection → unlocked only, don't abort).
    updateAssets: (patches: Array<{ id: string; patch: Partial<PlacedAsset> }>) => void;
    patchMetadata: (id: string, subkey: MetadataSubkey, patch: Record<string, unknown>) => void;
    removeAsset: (id: string) => void;

    // actions — selection (multi)
    selectAsset: (id: string | null) => void;                    // single-select (overwrites multi)
    toggleAssetInSelection: (id: string) => void;                // shift+click
    selectMultiple: (ids: string[]) => void;
    clearSelection: () => void;

    // actions — z-order (array order = draw order, front-most LAST)
    reorderAsset: (id: string, toIndex: number) => void;
    bringForward: (id: string) => void;
    sendBackward: (id: string) => void;

    // actions — view-meta (write through patchMetadata → metadata.view)
    setAssetHidden: (id: string, hidden: boolean) => void;
    setAssetLocked: (id: string, locked: boolean) => void;
    renameAsset: (id: string, label: string) => void;

    // actions — surfaces / materials (Stage 2)
    setActiveSurface: (s: RoomSurface | null) => void;
    setSurfaceMaterial: (surface: RoomSurface, materialId: string | null) => void;

    // actions — UI
    setViewMode: (mode: ViewMode) => void;
    setDragging: (isDragging: boolean) => void;
    startDraggingAsset: (id: string) => void;
    stopDraggingAsset: () => void;
    setToolMode: (m: ToolMode) => void;
    openContextMenu: (id: string, x: number, y: number) => void;
    closeContextMenu: () => void;
    setShowLayers: (v: boolean) => void;
    setShowMeasurements: (v: boolean) => void;
    setCameraPreset: (p: CameraPreset | "orbit") => void;

    // actions — placement (transient)
    startPlacing: (asset: Asset) => void;
    cancelPlacing: () => void;
    setSnapToGrid: (v: boolean) => void;
    setGridSize: (m: number) => void;
    requestFocusProperties: () => void;
    setTransformSnapLines: (lines: SnapLine[]) => void;

    // actions — history
    undo: () => void;
    redo: () => void;

    // actions — Stage 4 production toggles
    setHdriPreset: (p: HdriPreset) => void;     // writes layout.lighting.hdriPreset; history + dirty
    toggleEffects: () => void;                   // view-only
    togglePreviewMode: () => void;               // view-only
    openShortcutLegend: () => void;
    closeShortcutLegend: () => void;
    setOnboardingActive: (v: boolean) => void;
    setCanvasRefs: (r: CanvasRefs | null) => void;

    // actions — persistence
    markSaved: () => void;
    getSnapshot: () => RoomSnapshot;
}

const MAX_HISTORY = 50;

function pushHistory(state: RoomStoreState): PastSnapshot[] {
    const entry: PastSnapshot = { layout: state.layout, assets: state.assets };
    const next = [...state.past, entry];
    if (next.length > MAX_HISTORY) next.shift();
    return next;
}

// Deep-merge a metadata subkey patch. Preserves sibling subkeys.
function withMetadataPatch(
    asset: PlacedAsset,
    subkey: MetadataSubkey,
    patch: Record<string, unknown>,
): PlacedAsset {
    const old = (asset.metadata ?? {}) as Record<string, unknown>;
    const sub = ((old[subkey] as Record<string, unknown> | undefined) ?? {});
    return {
        ...asset,
        metadata: { ...old, [subkey]: { ...sub, ...patch } },
    };
}

export const useRoomStore = create<RoomStoreState>((set, get) => ({
    roomId: "",
    roomType: "kitchen",

    layout: { dimensions: { width: 0, length: 0, height: 0 }, walls: [], camera: { position: [0, 0, 0], target: [0, 0, 0] }, surfaces: {} },
    assets: [],
    selectedAssetIds: [],
    activeSurface: null,

    viewMode: "3d",
    isDragging: false,
    draggingAssetId: null,

    toolMode: "translate",
    contextMenu: null,
    showLayers: false,
    showMeasurements: false,
    cameraPreset: "orbit",

    effectsEnabled: true,
    previewMode: "design",
    shortcutLegendOpen: false,
    onboardingActive: false, // OnboardingCoach flips this on mount based on localStorage
    canvasRefs: null,

    placingAsset: null,
    snapToGrid: true,
    gridSize: 0.1524, // 6 inches
    focusPropertiesTick: 0,
    transformSnapLines: [],

    dirty: false,
    lastSavedAt: null,

    past: [],
    future: [],

    loadSnapshot: (snap) =>
        set({
            roomId: snap.roomId,
            roomType: snap.roomType,
            layout: snap.layout,
            assets: snap.assets,
            selectedAssetIds: [],
            activeSurface: null,
            placingAsset: null,
            contextMenu: null,
            past: [],
            future: [],
            dirty: false,
            lastSavedAt: Date.now(),
        }),

    setLayout: (layout) =>
        set((s) => ({
            past: pushHistory(s),
            future: [],
            layout,
            dirty: true,
        })),

    addAsset: (asset) =>
        set((s) => ({
            past: pushHistory(s),
            future: [],
            assets: [...s.assets, asset],
            selectedAssetIds: [asset.id],
            // Mutual exclusion (Stage 2 D3): selecting the new asset must
            // clear any active surface, otherwise MaterialLibrary is split-brain.
            activeSurface: null,
            dirty: true,
        })),

    updateAsset: (id, patch) =>
        set((s) => {
            const target = s.assets.find((a) => a.id === id);
            if (!target) return {};
            // Stage 3: silently no-op on locked assets. UI disables the controls.
            if (isLocked(target)) return {};
            return {
                past: pushHistory(s),
                future: [],
                assets: s.assets.map((a) => (a.id === id ? { ...a, ...patch } : a)),
                dirty: true,
            };
        }),

    updateAssets: (patches) =>
        set((s) => {
            // Filter out locked assets — mixed selection applies to unlocked only.
            const byId = new Map(s.assets.map((a) => [a.id, a] as const));
            const valid = patches.filter((p) => {
                const a = byId.get(p.id);
                return a && !isLocked(a);
            });
            if (valid.length === 0) return {};
            const patchMap = new Map(valid.map((p) => [p.id, p.patch] as const));
            return {
                past: pushHistory(s),
                future: [],
                assets: s.assets.map((a) => {
                    const p = patchMap.get(a.id);
                    return p ? { ...a, ...p } : a;
                }),
                dirty: true,
            };
        }),

    patchMetadata: (id, subkey, patch) => {
        const s = get();
        const target = s.assets.find((a) => a.id === id);
        if (!target) return;
        // NOTE: lock toggle itself writes through metadata.view, so don't
        // block `patchMetadata` when the target is locked — otherwise the
        // user can lock an asset but can never unlock it. The per-action
        // setters (setAssetLocked) always pass through here.
        set({
            past: pushHistory(s),
            future: [],
            assets: s.assets.map((a) => (a.id === id ? withMetadataPatch(a, subkey, patch) : a)),
            dirty: true,
        });
    },

    removeAsset: (id) =>
        set((s) => {
            const target = s.assets.find((a) => a.id === id);
            if (!target) return {};
            // Stage 3: locked assets can't be removed silently.
            if (isLocked(target)) return {};
            return {
                past: pushHistory(s),
                future: [],
                assets: s.assets.filter((a) => a.id !== id),
                selectedAssetIds: s.selectedAssetIds.filter((sid) => sid !== id),
                contextMenu: s.contextMenu?.id === id ? null : s.contextMenu,
                dirty: true,
            };
        }),

    selectAsset: (id) =>
        set((s) =>
            id !== null
                ? {
                    selectedAssetIds: [id],
                    activeSurface: null,
                    toolMode: s.selectedAssetIds.length === 0 ? "translate" as ToolMode : s.toolMode,
                }
                : { selectedAssetIds: [], activeSurface: s.activeSurface },
        ),

    toggleAssetInSelection: (id) =>
        set((s) => {
            const exists = s.selectedAssetIds.includes(id);
            const next = exists
                ? s.selectedAssetIds.filter((x) => x !== id)
                : [...s.selectedAssetIds, id];
            return { selectedAssetIds: next, activeSurface: next.length > 0 ? null : s.activeSurface };
        }),

    selectMultiple: (ids) =>
        set((s) => ({
            selectedAssetIds: [...ids],
            activeSurface: ids.length > 0 ? null : s.activeSurface,
        })),

    clearSelection: () =>
        set({ selectedAssetIds: [] }),

    reorderAsset: (id, toIndex) =>
        set((s) => {
            const from = s.assets.findIndex((a) => a.id === id);
            if (from < 0) return {};
            const clampedTo = Math.max(0, Math.min(s.assets.length - 1, toIndex));
            if (from === clampedTo) return {};
            const next = s.assets.slice();
            const [moved] = next.splice(from, 1);
            next.splice(clampedTo, 0, moved);
            return {
                past: pushHistory(s),
                future: [],
                assets: next,
                dirty: true,
            };
        }),

    bringForward: (id) => {
        const s = get();
        const idx = s.assets.findIndex((a) => a.id === id);
        if (idx < 0 || idx === s.assets.length - 1) return;
        s.reorderAsset(id, idx + 1);
    },

    sendBackward: (id) => {
        const s = get();
        const idx = s.assets.findIndex((a) => a.id === id);
        if (idx <= 0) return;
        s.reorderAsset(id, idx - 1);
    },

    setAssetHidden: (id, hidden) => {
        get().patchMetadata(id, "view", { hidden });
    },

    setAssetLocked: (id, locked) => {
        // Can't go through the normal patchMetadata pass; patchMetadata calls
        // would be blocked if we added lock-aware guards there. Current
        // patchMetadata does NOT check lock (per comment above) — safe to call.
        get().patchMetadata(id, "view", { locked });
    },

    renameAsset: (id, label) => {
        const trimmed = label.trim();
        get().patchMetadata(id, "view", { label: trimmed.length > 0 ? trimmed : undefined });
    },

    // Stage 2: surface selection (mirror of selectAsset's mutual exclusion).
    setActiveSurface: (s) =>
        set((state) =>
            s !== null
                ? { activeSurface: s, selectedAssetIds: [] }
                : { activeSurface: null, selectedAssetIds: state.selectedAssetIds },
        ),

    // Write-through to layout.surfaces so the change rides setLayout's
    // history → dirty → autosave pipeline unchanged.
    setSurfaceMaterial: (surface, materialId) => {
        const layout = get().layout;
        get().setLayout({
            ...layout,
            surfaces: { ...layout.surfaces, [surface]: materialId },
        });
    },

    setViewMode: (viewMode) => set({ viewMode }),
    setDragging: (isDragging) => set({ isDragging }),
    startDraggingAsset: (id) => set({ draggingAssetId: id }),
    stopDraggingAsset: () => set({ draggingAssetId: null }),
    setToolMode: (toolMode) => set({ toolMode }),
    openContextMenu: (id, x, y) => set({ contextMenu: { id, x, y } }),
    closeContextMenu: () => set({ contextMenu: null }),
    setShowLayers: (showLayers) => set({ showLayers }),
    setShowMeasurements: (showMeasurements) => set({ showMeasurements }),
    setCameraPreset: (cameraPreset) => set({ cameraPreset }),

    // Transient placement actions — never touch history or mark dirty.
    startPlacing: (asset) => set({ placingAsset: asset }),
    cancelPlacing: () => set({ placingAsset: null }),
    setSnapToGrid: (snapToGrid) => set({ snapToGrid }),
    setGridSize: (gridSize) => set({ gridSize }),
    requestFocusProperties: () =>
        set((s) => ({ focusPropertiesTick: s.focusPropertiesTick + 1 })),
    setTransformSnapLines: (transformSnapLines) => set({ transformSnapLines }),

    // Undo/redo MUST mark dirty = true so the next autosave writes the new current position.
    // Treating undo as "back to clean state" is the common bug that lets the server retain
    // the previously-saved-but-undone edit.
    undo: () =>
        set((s) => {
            if (s.past.length === 0) return {};
            const prev = s.past[s.past.length - 1];
            const current: PastSnapshot = { layout: s.layout, assets: s.assets };
            return {
                past: s.past.slice(0, -1),
                future: [...s.future, current].slice(-MAX_HISTORY),
                layout: prev.layout,
                assets: prev.assets,
                selectedAssetIds: [],
                dirty: true,
            };
        }),

    redo: () =>
        set((s) => {
            if (s.future.length === 0) return {};
            const next = s.future[s.future.length - 1];
            const current: PastSnapshot = { layout: s.layout, assets: s.assets };
            return {
                future: s.future.slice(0, -1),
                past: [...s.past, current].slice(-MAX_HISTORY),
                layout: next.layout,
                assets: next.assets,
                selectedAssetIds: [],
                dirty: true,
            };
        }),

    // Stage 4: HDRI preset writes through layout.lighting so it rides the
    // setLayout → history → dirty → autosave pipeline. No extra plumbing.
    setHdriPreset: (p) => {
        const layout = get().layout;
        const current = layout.lighting?.hdriPreset ?? DEFAULT_PRESET;
        if (current === p) return; // no-op when unchanged (keeps history clean)
        get().setLayout({
            ...layout,
            lighting: { ...(layout.lighting ?? { hdriPreset: DEFAULT_PRESET }), hdriPreset: p },
        });
    },

    toggleEffects: () => set((s) => ({ effectsEnabled: !s.effectsEnabled })),
    togglePreviewMode: () =>
        set((s) => ({ previewMode: s.previewMode === "design" ? "empty" : "design" })),
    openShortcutLegend: () => set({ shortcutLegendOpen: true }),
    closeShortcutLegend: () => set({ shortcutLegendOpen: false }),
    setOnboardingActive: (onboardingActive) => set({ onboardingActive }),
    setCanvasRefs: (canvasRefs) => set({ canvasRefs }),

    markSaved: () => set({ dirty: false, lastSavedAt: Date.now() }),

    getSnapshot: () => {
        const s = get();
        return {
            roomId: s.roomId,
            roomType: s.roomType,
            layout: s.layout,
            assets: s.assets,
        };
    },
}));

// Selector helper: returns the first selected asset id (or null) for
// single-selection call sites (PropertiesPanel, configurators, keyboard
// nudges, gizmo target). Multi-select-aware code reads `selectedAssetIds`
// directly.
export function useSelectedAssetId(): string | null {
    return useRoomStore((s) => s.selectedAssetIds[0] ?? null);
}
