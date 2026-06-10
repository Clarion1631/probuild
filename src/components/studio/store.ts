"use client";

// Room Studio - zustand store.
//
// Performance contract: NOTHING in this store updates per-frame. Dragging
// mutates three.js objects directly (see canvas/ItemNode) and commits the
// final position here on pointer-up. Every commit = one undo step.

import { create } from "zustand";
import type { DesignDoc, PlacedItem } from "@/lib/studio/doc";
import { emptyDoc, newItemId } from "@/lib/studio/doc";
import { getItemDef, type CatalogItem } from "@/lib/studio/catalog";

export type ViewMode = "plan" | "orbit" | "walk";
export type SaveState = "saved" | "unsaved" | "saving" | "error";

const UNDO_CAP = 60;

interface StudioState {
  doc: DesignDoc;
  selectedId: string | null;
  /** Catalog item armed for click-to-place (ghost follows cursor). */
  placing: CatalogItem | null;
  view: ViewMode;
  lightsOn: boolean;
  presentMode: boolean;
  /** Surface paint target: when a wall/floor is clicked with the finish panel open. */
  activeSurface:
    | { kind: "wall"; wallIndex: number }
    | { kind: "floor" }
    | { kind: "corner"; index: number }
    | null;
  /** True while an item drag is in progress (disables camera controls; no autosave). */
  dragging: boolean;
  saveState: SaveState;
  dirty: boolean;
  /** Monotonic edit revision - bumped on EVERY doc change. Autosave compares
      the revision it saved against the current one before clearing dirty. */
  docRev: number;
  /** Bumped on every doc replacement that ISN'T from user edits (load, undo) so canvas effects can resync. */
  docEpoch: number;

  undoStack: DesignDoc[];
  redoStack: DesignDoc[];

  // -- lifecycle --
  loadDoc: (doc: DesignDoc) => void;
  markSaving: () => void;
  /** Clear dirty only if nothing changed since `savedRev` was captured. */
  markSaved: (savedRev: number) => void;
  markSaveError: () => void;

  // -- edits (each = undo step) --
  commitDoc: (next: DesignDoc) => void;
  addItem: (defId: string, pos: { x: number; z: number; rotation?: number; y?: number }) => string | null;
  updateItem: (id: string, patch: Partial<PlacedItem>) => void;
  removeItem: (id: string) => void;
  duplicateItem: (id: string) => string | null;
  setFloorFinish: (finishId: string) => void;
  setCeilingFinish: (finishId: string) => void;
  setWallPaint: (wallIndex: number | "all", finishId: string) => void;
  setRoomShape: (room: DesignDoc["room"]) => void;
  /** Live preview while dragging walls/corners in plan view - no undo step,
      no dirty flag. Call setRoomShape with the final shape on release. */
  previewRoomShape: (room: DesignDoc["room"]) => void;
  saveCamera: (camera: DesignDoc["camera"]) => void;

  undo: () => void;
  redo: () => void;

  // -- UI state (no undo) --
  select: (id: string | null) => void;
  setPlacing: (item: CatalogItem | null) => void;
  setView: (view: ViewMode) => void;
  setLightsOn: (on: boolean) => void;
  setPresentMode: (on: boolean) => void;
  setActiveSurface: (s: StudioState["activeSurface"]) => void;
  setDragging: (on: boolean) => void;
}

export const useStudio = create<StudioState>((set, get) => ({
  doc: emptyDoc(),
  selectedId: null,
  placing: null,
  view: "orbit",
  lightsOn: true,
  presentMode: false,
  activeSurface: null,
  dragging: false,
  saveState: "saved",
  dirty: false,
  docRev: 0,
  docEpoch: 0,
  undoStack: [],
  redoStack: [],

  loadDoc: (doc) =>
    set((s) => ({
      doc,
      undoStack: [],
      redoStack: [],
      selectedId: null,
      dirty: false,
      saveState: "saved",
      docRev: s.docRev + 1,
      docEpoch: s.docEpoch + 1,
    })),

  markSaving: () => set({ saveState: "saving" }),
  markSaved: (savedRev) =>
    set((s) =>
      s.docRev === savedRev
        ? { saveState: "saved", dirty: false }
        : { saveState: "unsaved" }, // newer edits arrived while saving - stay dirty
    ),
  markSaveError: () => set({ saveState: "error" }),

  commitDoc: (next) =>
    set((s) => ({
      doc: next,
      undoStack: [...s.undoStack.slice(-UNDO_CAP + 1), s.doc],
      redoStack: [],
      dirty: true,
      saveState: "unsaved",
      docRev: s.docRev + 1,
    })),

  addItem: (defId, pos) => {
    const def = getItemDef(defId);
    if (!def) return null;
    const id = newItemId();
    const item: PlacedItem = {
      id,
      defId: def.id,
      x: pos.x,
      z: pos.z,
      y: pos.y,
      rotation: pos.rotation ?? 0,
    };
    const s = get();
    s.commitDoc({ ...s.doc, items: [...s.doc.items, item] });
    set({ selectedId: id });
    return id;
  },

  updateItem: (id, patch) => {
    const s = get();
    const items = s.doc.items.map((it) => (it.id === id ? { ...it, ...patch } : it));
    s.commitDoc({ ...s.doc, items });
  },

  removeItem: (id) => {
    const s = get();
    s.commitDoc({ ...s.doc, items: s.doc.items.filter((it) => it.id !== id) });
    if (s.selectedId === id) set({ selectedId: null });
  },

  duplicateItem: (id) => {
    const s = get();
    const src = s.doc.items.find((it) => it.id === id);
    if (!src) return null;
    const def = getItemDef(src.defId);
    const offset = (def?.w ?? 0.6) + 0.05;
    const nid = newItemId();
    const copy: PlacedItem = {
      ...src,
      id: nid,
      x: src.x + Math.cos(src.rotation) * offset,
      z: src.z - Math.sin(src.rotation) * offset,
    };
    s.commitDoc({ ...s.doc, items: [...s.doc.items, copy] });
    set({ selectedId: nid });
    return nid;
  },

  setFloorFinish: (finishId) => {
    const s = get();
    s.commitDoc({ ...s.doc, surfaces: { ...s.doc.surfaces, floor: finishId } });
  },

  setCeilingFinish: (finishId) => {
    const s = get();
    s.commitDoc({ ...s.doc, surfaces: { ...s.doc.surfaces, ceiling: finishId } });
  },

  setWallPaint: (wallIndex, finishId) => {
    const s = get();
    const walls = { ...s.doc.surfaces.walls };
    if (wallIndex === "all") {
      // Reset per-wall overrides - one color everywhere.
      for (const k of Object.keys(walls)) delete walls[k];
      walls.all = finishId;
    } else {
      walls[String(wallIndex)] = finishId;
    }
    s.commitDoc({ ...s.doc, surfaces: { ...s.doc.surfaces, walls } });
  },

  setRoomShape: (room) => {
    const s = get();
    s.commitDoc({ ...s.doc, room });
  },

  previewRoomShape: (room) => set((s) => ({ doc: { ...s.doc, room } })),

  saveCamera: (camera) => {
    // Camera saves should NOT create undo steps; fold into the doc silently
    // but still bump the revision so autosave sees the change.
    set((s) => ({
      doc: { ...s.doc, camera },
      dirty: true,
      docRev: s.docRev + 1,
      saveState: s.saveState === "saved" ? "unsaved" : s.saveState,
    }));
  },

  undo: () =>
    set((s) => {
      const prev = s.undoStack[s.undoStack.length - 1];
      if (!prev) return s;
      return {
        doc: prev,
        undoStack: s.undoStack.slice(0, -1),
        redoStack: [...s.redoStack, s.doc],
        dirty: true,
        saveState: "unsaved",
        selectedId: null,
        docRev: s.docRev + 1,
        docEpoch: s.docEpoch + 1,
      };
    }),

  redo: () =>
    set((s) => {
      const next = s.redoStack[s.redoStack.length - 1];
      if (!next) return s;
      return {
        doc: next,
        redoStack: s.redoStack.slice(0, -1),
        undoStack: [...s.undoStack, s.doc],
        dirty: true,
        saveState: "unsaved",
        selectedId: null,
        docRev: s.docRev + 1,
        docEpoch: s.docEpoch + 1,
      };
    }),

  select: (id) => set({ selectedId: id, activeSurface: id ? null : get().activeSurface }),
  setPlacing: (item) => set({ placing: item, selectedId: item ? null : get().selectedId }),
  setView: (view) => set({ view }),
  setLightsOn: (on) => set({ lightsOn: on }),
  setPresentMode: (on) => set({ presentMode: on, selectedId: null, placing: null }),
  setActiveSurface: (activeSurface) => set({ activeSurface, selectedId: activeSurface ? null : get().selectedId }),
  setDragging: (dragging) => set({ dragging }),
}));

/** Convenience selector: the currently-selected placed item, or null. */
export function useSelectedItem(): PlacedItem | null {
  return useStudio((s) => (s.selectedId ? s.doc.items.find((it) => it.id === s.selectedId) ?? null : null));
}

// Dev-only escape hatch for local QA tooling (drive the store from the console).
if (typeof window !== "undefined" && process.env.NODE_ENV === "development") {
  (window as unknown as { __studioStore?: typeof useStudio }).__studioStore = useStudio;
}
