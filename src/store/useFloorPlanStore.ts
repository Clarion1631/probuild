import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';

export type ToolType = 'select' | 'drawWall' | 'drawDoor' | 'drawWindow' | 'drawProduct_sofa' | 'drawProduct_coffeeTable' | 'drawProduct_island' | 'drawProduct_cabinetBase';

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
    productType: 'sofa' | 'coffeeTable' | 'island' | 'cabinetBase';
    position: Point3D;
    rotation: number;
    width: number;
    height: number;
    depth: number;
}

export type FloorPlanElement = Wall | WallAttachment | GenericProduct;

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

    // Actions
    addWall: (start: Point3D, end: Point3D, height?: number, thickness?: number) => void;
    addAttachment: (attachment: Omit<WallAttachment, 'id'>) => void;
    addProduct: (product: Omit<GenericProduct, 'id'>) => void;
    updateWall: (id: string, updates: Partial<Wall>) => void;
    updateAttachment: (id: string, updates: Partial<WallAttachment>) => void;
    updateProduct: (id: string, updates: Partial<GenericProduct>) => void;
    removeElement: (id: string) => void;
    selectElement: (id: string | null) => void;

    // Drawing State
    draftWallStart: Point3D | null;
    setDraftWallStart: (point: Point3D | null) => void;

    // Dragging State
    draggingNode: { wallId: string; node: 'start' | 'end' | 'center' } | null;
    setDraggingNode: (node: { wallId: string; node: 'start' | 'end' | 'center' } | null) => void;
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

    addWall: (start, end, height = 8.0, thickness = 0.5) => set((state) => ({
        elements: [...state.elements, { id: uuidv4(), type: 'wall', start, end, height, thickness }]
    })),

    addAttachment: (attachment) => set((state) => ({
        elements: [...state.elements, { ...attachment, id: uuidv4() }]
    })),

    addProduct: (product) => set((state) => ({
        elements: [...state.elements, { ...product, id: uuidv4() }]
    })),

    updateWall: (id, updates) => set((state) => ({
        elements: state.elements.map(el => (el.id === id && el.type === 'wall') ? { ...el, ...updates } : el)
    })),

    updateAttachment: (id, updates) => set((state) => ({
        elements: state.elements.map(el => (el.id === id && (el.type === 'door' || el.type === 'window')) ? { ...el, ...updates } : el)
    })),

    updateProduct: (id, updates) => set((state) => ({
        elements: state.elements.map(el => (el.id === id && el.type === 'product') ? { ...el, ...updates } : el)
    })),

    removeElement: (id) => set((state) => {
        // If deleting a wall, also delete its attachments
        const elementToDelete = state.elements.find(el => el.id === id);
        if (elementToDelete?.type === 'wall') {
            return {
                elements: state.elements.filter(el => el.id !== id && (el.type === 'wall' || el.type === 'product' || (el as WallAttachment).wallId !== id)),
                selectedElementId: state.selectedElementId === id ? null : state.selectedElementId
            };
        }

        return {
            elements: state.elements.filter(el => el.id !== id),
            selectedElementId: state.selectedElementId === id ? null : state.selectedElementId
        }
    }),

    selectElement: (id) => set({ selectedElementId: id }),

    draftWallStart: null,
    setDraftWallStart: (point) => set({ draftWallStart: point }),

    draggingNode: null,
    setDraggingNode: (node) => set({ draggingNode: node }),
}));
