import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';

export type ToolType = 'select' | 'drawWall' | 'drawDoor' | 'drawWindow' | 'drawProduct_sofa' | 'drawProduct_coffeeTable' | 'drawProduct_island' | 'drawProduct_cabinetBase';

export type ProductType = 'sofa' | 'coffeeTable' | 'island' | 'cabinetBase';

export const PRODUCT_DEFAULTS: Record<ProductType, { width: number; height: number; depth: number }> = {
    sofa: { width: 6, height: 2.5, depth: 3 },
    coffeeTable: { width: 4, height: 1.5, depth: 2 },
    island: { width: 6, height: 3, depth: 3 },
    cabinetBase: { width: 2, height: 3, depth: 2 },
};

export interface Point3D {
    x: number;
    y: number;
    z: number;
}

export interface Wall {
    id: string;
    type: 'wall';
    start: Point3D;
    end: Point3D;
    height: number;
    thickness: number;
}

export interface WallAttachment {
    id: string;
    type: 'door' | 'window';
    wallId: string;
    distanceFromStart: number; // Center position along the wall length
    width: number;
    height: number;
    elevation: number; // Distance from floor to bottom of element
    isFlipped?: boolean; // Toggles whether the attachment opens inward or outward (rotates 180 deg)
}

export interface GenericProduct {
    id: string;
    type: 'product';
    productType: ProductType;
    position: Point3D;
    rotation: number;
    width: number;
    height: number;
    depth: number;
}

export type FloorPlanElement = Wall | WallAttachment | GenericProduct;

const MAX_HISTORY = 50;

export interface FloorPlanState {
    // Tools and UI state
    activeTool: ToolType;
    setActiveTool: (tool: ToolType) => void;

    // Floor settings
    showFloor: boolean;
    setShowFloor: (show: boolean) => void;

    // Settings
    snapEnabled: boolean;
    setSnapEnabled: (snap: boolean) => void;

    // Scene Elements
    elements: FloorPlanElement[];
    selectedElementId: string | null;

    // Undo/Redo History
    past: FloorPlanElement[][];
    future: FloorPlanElement[][];
    undo: () => void;
    redo: () => void;

    // Actions
    addWall: (start: Point3D, end: Point3D, height?: number, thickness?: number) => void;
    addAttachment: (attachment: Omit<WallAttachment, 'id'>) => void;
    addProduct: (product: Omit<GenericProduct, 'id'>) => void;
    updateWall: (id: string, updates: Partial<Wall>) => void;
    updateAttachment: (id: string, updates: Partial<WallAttachment>) => void;
    updateProduct: (id: string, updates: Partial<GenericProduct>) => void;
    removeElement: (id: string) => void;
    selectElement: (id: string | null) => void;

    // Persistence
    loadElements: (elements: FloorPlanElement[]) => void;
    getSerializableState: () => string;

    // Drawing State
    draftWallStart: Point3D | null;
    setDraftWallStart: (point: Point3D | null) => void;

    // Dragging State
    draggingNode: { elementId: string; node: 'start' | 'end' | 'center' } | null;
    setDraggingNode: (node: { elementId: string; node: 'start' | 'end' | 'center' } | null) => void;
}

// Helper to push current elements onto the past stack
function pushHistory(state: FloorPlanState): { past: FloorPlanElement[][]; future: FloorPlanElement[][] } {
    return {
        past: [...state.past.slice(-(MAX_HISTORY - 1)), state.elements],
        future: [],
    };
}

export const useFloorPlanStore = create<FloorPlanState>((set, get) => ({
    activeTool: 'select',
    setActiveTool: (tool) => set({ activeTool: tool, selectedElementId: null, draftWallStart: null }),

    showFloor: false,
    setShowFloor: (show) => set({ showFloor: show }),

    snapEnabled: true,
    setSnapEnabled: (snap) => set({ snapEnabled: snap }),

    elements: [],
    selectedElementId: null,

    // Undo/Redo
    past: [],
    future: [],

    undo: () => set((state) => {
        if (state.past.length === 0) return state;
        const previous = state.past[state.past.length - 1];
        return {
            past: state.past.slice(0, -1),
            future: [state.elements, ...state.future],
            elements: previous,
            selectedElementId: null,
        };
    }),

    redo: () => set((state) => {
        if (state.future.length === 0) return state;
        const next = state.future[0];
        return {
            past: [...state.past, state.elements],
            future: state.future.slice(1),
            elements: next,
            selectedElementId: null,
        };
    }),

    addWall: (start, end, height = 8.0, thickness = 0.5) => set((state) => ({
        ...pushHistory(state),
        elements: [...state.elements, { id: uuidv4(), type: 'wall', start, end, height, thickness }]
    })),

    addAttachment: (attachment) => set((state) => ({
        ...pushHistory(state),
        elements: [...state.elements, { ...attachment, id: uuidv4() }]
    })),

    addProduct: (product) => set((state) => ({
        ...pushHistory(state),
        elements: [...state.elements, { ...product, id: uuidv4() }]
    })),

    updateWall: (id, updates) => set((state) => ({
        ...pushHistory(state),
        elements: state.elements.map(el => (el.id === id && el.type === 'wall') ? { ...el, ...updates } : el)
    })),

    updateAttachment: (id, updates) => set((state) => ({
        ...pushHistory(state),
        elements: state.elements.map(el => (el.id === id && (el.type === 'door' || el.type === 'window')) ? { ...el, ...updates } : el)
    })),

    updateProduct: (id, updates) => set((state) => ({
        ...pushHistory(state),
        elements: state.elements.map(el => (el.id === id && el.type === 'product') ? { ...el, ...updates } : el)
    })),

    removeElement: (id) => set((state) => {
        const history = pushHistory(state);
        // If deleting a wall, also delete its attachments
        const elementToDelete = state.elements.find(el => el.id === id);
        if (elementToDelete?.type === 'wall') {
            return {
                ...history,
                elements: state.elements.filter(el => el.id !== id && (el.type === 'wall' || el.type === 'product' || (el as WallAttachment).wallId !== id)),
                selectedElementId: state.selectedElementId === id ? null : state.selectedElementId
            };
        }

        return {
            ...history,
            elements: state.elements.filter(el => el.id !== id),
            selectedElementId: state.selectedElementId === id ? null : state.selectedElementId
        }
    }),

    selectElement: (id) => set({ selectedElementId: id }),

    // Persistence
    loadElements: (elements) => set({ elements, past: [], future: [], selectedElementId: null }),
    getSerializableState: () => JSON.stringify(get().elements),

    draftWallStart: null,
    setDraftWallStart: (point) => set({ draftWallStart: point }),

    draggingNode: null,
    setDraggingNode: (node) => set({ draggingNode: node }),
}));
