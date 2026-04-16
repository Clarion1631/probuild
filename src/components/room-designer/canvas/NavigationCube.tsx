// Stage 3: bottom-right navigation cube. Uses drei's GizmoHelper + GizmoViewcube
// — clicking a face rotates the default camera. We don't sync back to the
// cameraPreset store field because the cube reads the live camera, so visual
// sync is automatic. The explicit path is the preset toolbar.
//
// Hidden in 2D because the cube rotating an ortho camera is visually
// meaningless (and drei's ortho faces aren't readable at top-down angles).

import { GizmoHelper, GizmoViewcube } from "@react-three/drei";
import { useRoomStore } from "@/components/room-designer/hooks/useRoomStore";

export function NavigationCube() {
    const viewMode = useRoomStore((s) => s.viewMode);
    if (viewMode !== "3d") return null;

    return (
        <GizmoHelper alignment="bottom-right" margin={[72, 72]}>
            <GizmoViewcube
                color="#f8fafc"
                opacity={0.95}
                strokeColor="#94a3b8"
                textColor="#1f2937"
                hoverColor="#bfdbfe"
            />
        </GizmoHelper>
    );
}
