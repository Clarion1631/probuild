// Vertical strip of icon affordances docked to the right edge of the canvas.
// Surfaces the Layers / Properties panel toggles (previously keyboard-only via
// L / M) plus a camera-fit shortcut and a quick preset-cycle button.

import { useRoomStore } from "./hooks/useRoomStore";
import { IconButton } from "@/components/ui/IconButton";
import type { CameraPreset } from "./types";
import { Layers, Orbit, ScanLine, SlidersHorizontal } from "lucide-react";

const CYCLE_ORDER: CameraPreset[] = ["iso", "top", "front", "right"];

export function RightRail() {
    const showLayers = useRoomStore((s) => s.showLayers);
    const setShowLayers = useRoomStore((s) => s.setShowLayers);
    const showProperties = useRoomStore((s) => s.showProperties);
    const setShowProperties = useRoomStore((s) => s.setShowProperties);
    const cameraPreset = useRoomStore((s) => s.cameraPreset);
    const setCameraPreset = useRoomStore((s) => s.setCameraPreset);
    const viewMode = useRoomStore((s) => s.viewMode);

    const fitCamera = () => {
        const target: CameraPreset = viewMode === "2d" ? "top" : "iso";
        setCameraPreset("orbit");
        setTimeout(() => setCameraPreset(target), 0);
    };

    const cycleCamera = () => {
        const idx = CYCLE_ORDER.indexOf(cameraPreset as CameraPreset);
        const next = CYCLE_ORDER[(idx + 1) % CYCLE_ORDER.length];
        setCameraPreset(next);
    };

    return (
        <div className="flex w-12 shrink-0 flex-col items-center gap-1 border-l border-slate-200 bg-white py-3">
            <IconButton
                icon={<Layers />}
                label="Toggle Layers (L)"
                pressed={showLayers}
                onClick={() => setShowLayers(!showLayers)}
            />
            <IconButton
                icon={<SlidersHorizontal />}
                label="Toggle Properties (M)"
                pressed={showProperties}
                onClick={() => setShowProperties(!showProperties)}
            />
            <div className="my-1 h-px w-6 bg-slate-200" aria-hidden />
            <IconButton
                icon={<ScanLine />}
                label="Fit to view"
                onClick={fitCamera}
            />
            <IconButton
                icon={<Orbit />}
                label="Cycle camera angle"
                onClick={cycleCamera}
            />
        </div>
    );
}
