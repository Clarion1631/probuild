// Shared refs mounted inside <Canvas> so TransformGizmo can imperatively
// attach/detach to an AssetNode's group, and so the camera-preset animator
// can lerp the OrbitControls target. R3F state is canvas-scoped, so this
// provider lives inside the <Canvas>.

import { createContext, useContext, useMemo, useRef, type ReactNode, type RefObject } from "react";
import type { Group } from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";

interface CanvasContextValue {
    orbitRef: RefObject<OrbitControlsImpl | null>;
    meshRefs: RefObject<Map<string, Group>>;
}

const CanvasContext = createContext<CanvasContextValue | null>(null);

export function CanvasContextProvider({ children }: { children: ReactNode }) {
    const orbitRef = useRef<OrbitControlsImpl | null>(null);
    const meshRefs = useRef<Map<string, Group>>(new Map());
    const value = useMemo<CanvasContextValue>(() => ({ orbitRef, meshRefs }), []);
    return <CanvasContext.Provider value={value}>{children}</CanvasContext.Provider>;
}

export function useCanvasContext(): CanvasContextValue {
    const ctx = useContext(CanvasContext);
    if (!ctx) throw new Error("useCanvasContext must be used inside CanvasContextProvider");
    return ctx;
}
