// Zustand store for a single Room Designer session.
//
// FUTURE MOBILE: Zustand works unchanged on React Native. No browser APIs here.

import { create } from "zustand";
import type {
    PlacedAsset,
    RoomLayout,
    RoomSnapshot,
    RoomType,
    ViewMode,
} from "@/components/room-designer/types";

type PastSnapshot = { layout: RoomLayout; assets: PlacedAsset[] };

export interface RoomStoreState {
    // session identity
    roomId: string;
    roomType: RoomType;

    // scene
    layout: RoomLayout;
    assets: PlacedAsset[];
    selectedAssetId: string | null;

    // UI
    viewMode: ViewMode;
    isDragging: boolean;

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
    removeAsset: (id: string) => void;
    selectAsset: (id: string | null) => void;

    // actions — UI
    setViewMode: (mode: ViewMode) => void;
    setDragging: (isDragging: boolean) => void;

    // actions — history
    undo: () => void;
    redo: () => void;

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

export const useRoomStore = create<RoomStoreState>((set, get) => ({
    roomId: "",
    roomType: "kitchen",

    layout: { dimensions: { width: 0, length: 0, height: 0 }, walls: [], camera: { position: [0, 0, 0], target: [0, 0, 0] }, surfaces: {} },
    assets: [],
    selectedAssetId: null,

    viewMode: "3d",
    isDragging: false,

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
            selectedAssetId: null,
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
            selectedAssetId: asset.id,
            dirty: true,
        })),

    updateAsset: (id, patch) =>
        set((s) => ({
            past: pushHistory(s),
            future: [],
            assets: s.assets.map((a) => (a.id === id ? { ...a, ...patch } : a)),
            dirty: true,
        })),

    removeAsset: (id) =>
        set((s) => ({
            past: pushHistory(s),
            future: [],
            assets: s.assets.filter((a) => a.id !== id),
            selectedAssetId: s.selectedAssetId === id ? null : s.selectedAssetId,
            dirty: true,
        })),

    selectAsset: (id) => set({ selectedAssetId: id }),

    setViewMode: (viewMode) => set({ viewMode }),
    setDragging: (isDragging) => set({ isDragging }),

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
                selectedAssetId: null,
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
                selectedAssetId: null,
                dirty: true,
            };
        }),

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
