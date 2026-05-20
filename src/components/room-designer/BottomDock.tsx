// Floating bottom dock — view-mode controls + camera presets + screenshot.
// Replaces the Undo/Redo, 2D/3D, Layers, Measure, Lighting, FX, etc. controls
// that used to live in the cramped top toolbar. The selection-only CAD bar
// (single-asset dim inputs, multi-asset alignment) sits stacked above this
// one at bottom-20 when something is selected.

import { useRoomStore } from "./hooks/useRoomStore";
import { useRoomExports } from "./hooks/useRoomExports";
import type { OwnerContext } from "@/lib/room-designer/owner-context";
import type { CameraPreset } from "./types";
import { FloatingDock, FloatingDockDivider } from "./ui/FloatingDock";
import { IconButton } from "@/components/ui/IconButton";
import {
    Camera,
    Maximize2,
    Redo2,
    Ruler,
    Undo2,
} from "lucide-react";

interface BottomDockProps {
    ownerContext: OwnerContext;
    roomName: string;
}

interface PresetBtn {
    key: CameraPreset | "fit";
    label: string;
    title: string;
}

const PRESETS: PresetBtn[] = [
    { key: "fit", label: "Fit", title: "Fit room to view" },
    { key: "top", label: "Top", title: "Top (plan) view" },
    { key: "front", label: "Front", title: "Front elevation" },
    { key: "right", label: "Side", title: "Right-side elevation" },
    { key: "iso", label: "3D", title: "3D perspective" },
];

export function BottomDock({ ownerContext, roomName }: BottomDockProps) {
    const undo = useRoomStore((s) => s.undo);
    const redo = useRoomStore((s) => s.redo);
    const past = useRoomStore((s) => s.past);
    const future = useRoomStore((s) => s.future);
    const viewMode = useRoomStore((s) => s.viewMode);
    const setViewMode = useRoomStore((s) => s.setViewMode);
    const currentPreset = useRoomStore((s) => s.cameraPreset);
    const setCameraPreset = useRoomStore((s) => s.setCameraPreset);
    const showMeasurements = useRoomStore((s) => s.showMeasurements);
    const setShowMeasurements = useRoomStore((s) => s.setShowMeasurements);

    const { exportPng, exportingPng } = useRoomExports({ ownerContext, roomName });

    const onPresetClick = (key: PresetBtn["key"]) => {
        if (key === "fit") {
            const target: CameraPreset = viewMode === "2d" ? "top" : "iso";
            setCameraPreset("orbit");
            setTimeout(() => setCameraPreset(target), 0);
            return;
        }
        setCameraPreset(key);
    };

    return (
        <FloatingDock>
            {/* Undo / Redo */}
            <div className="flex items-center gap-0.5">
                <IconButton
                    size="sm"
                    icon={<Undo2 />}
                    label="Undo (Ctrl+Z)"
                    onClick={undo}
                    disabled={past.length === 0}
                />
                <IconButton
                    size="sm"
                    icon={<Redo2 />}
                    label="Redo (Ctrl+Y)"
                    onClick={redo}
                    disabled={future.length === 0}
                />
            </div>

            <FloatingDockDivider />

            {/* View mode 2D / 3D switcher */}
            <div className="flex bg-slate-100 p-0.5 rounded-full border border-slate-200">
                <button
                    type="button"
                    onClick={() => setViewMode("2d")}
                    className={`px-3 py-1 rounded-full text-[11px] font-bold transition-all duration-200 ${
                        viewMode === "2d" 
                            ? "bg-[#531b7e] text-white shadow-sm" 
                            : "text-slate-600 hover:text-slate-950"
                    }`}
                >
                    2D
                </button>
                <button
                    type="button"
                    onClick={() => setViewMode("3d")}
                    className={`px-3 py-1 rounded-full text-[11px] font-bold transition-all duration-200 ${
                        viewMode === "3d" 
                            ? "bg-[#531b7e] text-white shadow-sm" 
                            : "text-slate-600 hover:text-slate-950"
                    }`}
                >
                    3D
                </button>
            </div>

            <FloatingDockDivider />

            {/* Camera presets */}
            <div className="flex items-center gap-1">
                {PRESETS.map((p) => {
                    const active = p.key !== "fit" && currentPreset === p.key;
                    return (
                        <button
                            key={p.key}
                            type="button"
                            title={p.title}
                            onClick={() => onPresetClick(p.key)}
                            className={`rounded-full px-3 py-1 text-[11px] font-bold transition-all duration-200 ${
                                active
                                    ? "bg-[#531b7e] text-white shadow-sm"
                                    : "bg-transparent text-slate-600 hover:bg-slate-100 hover:text-slate-950"
                            }`}
                        >
                            {p.key === "fit" ? (
                                <span className="flex items-center gap-1"><Maximize2 className="h-3 w-3" /> Fit</span>
                            ) : p.label}
                        </button>
                    );
                })}
            </div>

            <FloatingDockDivider />

            {/* Measurements toggle + screenshot */}
            <div className="flex items-center gap-0.5">
                <IconButton
                    size="sm"
                    icon={<Ruler />}
                    label="Measurements (M)"
                    pressed={showMeasurements}
                    onClick={() => setShowMeasurements(!showMeasurements)}
                />
                <IconButton
                    size="sm"
                    icon={<Camera />}
                    label="Screenshot (PNG)"
                    onClick={exportPng}
                    disabled={exportingPng}
                />
            </div>
        </FloatingDock>
    );
}
