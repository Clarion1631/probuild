// Stage 3: camera preset toolbar. Top-right overlay inside the canvas wrapper.
// Click → store.setCameraPreset triggers the useCameraPresets animator.
// "Fit" re-triggers the current mode's preset so the room fills the view.

import { useRoomStore } from "./hooks/useRoomStore";
import type { CameraPreset } from "./types";

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

export function ViewPresetToolbar() {
    const current = useRoomStore((s) => s.cameraPreset);
    const setCameraPreset = useRoomStore((s) => s.setCameraPreset);
    const viewMode = useRoomStore((s) => s.viewMode);

    const onClick = (key: PresetBtn["key"]) => {
        if (key === "fit") {
            // "Fit" re-applies the current mode's preset — re-triggers the
            // animator by setting "orbit" first to bypass the no-op when the
            // preset value is unchanged.
            const target: CameraPreset = viewMode === "2d" ? "top" : "iso";
            setCameraPreset("orbit");
            setTimeout(() => setCameraPreset(target), 0);
            return;
        }
        setCameraPreset(key);
    };

    return (
        <div className="pointer-events-auto absolute right-3 top-3 z-10 flex gap-1 rounded-md border border-slate-200 bg-white/95 p-1 shadow-md backdrop-blur">
            {PRESETS.map((p) => {
                const active = p.key !== "fit" && current === p.key;
                return (
                    <button
                        key={p.key}
                        type="button"
                        title={p.title}
                        onClick={() => onClick(p.key)}
                        className={
                            "rounded px-2.5 py-1 text-xs font-medium " +
                            (active
                                ? "bg-blue-500 text-white"
                                : "bg-white text-slate-700 hover:bg-slate-100")
                        }
                    >
                        {p.label}
                    </button>
                );
            })}
        </div>
    );
}
