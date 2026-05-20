// Appliance-specific metadata editor. Brand text input + 4 finish swatches.

import type { ApplianceFinish, ApplianceMeta, PlacedAsset } from "./types";
import { APPLIANCE_FINISH_COLORS } from "@/lib/room-designer/asset-resolve";
import { useRoomStore } from "./hooks/useRoomStore";

const FINISHES: Array<{ key: ApplianceFinish; label: string }> = [
    { key: "stainless", label: "Stainless" },
    { key: "black-ss", label: "Black SS" },
    { key: "white", label: "White" },
    { key: "panel-ready", label: "Panel-Ready" },
];

interface ApplianceInputRef {
    refForFocus?: React.RefObject<HTMLInputElement | null>;
}

interface ApplianceProps extends ApplianceInputRef {
    placed: PlacedAsset;
}

export function ApplianceProperties({ placed, refForFocus }: ApplianceProps) {
    const patchMetadata = useRoomStore((s) => s.patchMetadata);
    const meta = (placed.metadata?.appliance ?? {}) as ApplianceMeta;

    const write = (patch: Partial<ApplianceMeta>) =>
        patchMetadata(placed.id, "appliance", patch as Record<string, unknown>);

    return (
        <div className="space-y-3">
            <section>
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Brand</div>
                <input
                    ref={refForFocus}
                    type="text"
                    value={meta.brand ?? ""}
                    onChange={(e) => write({ brand: e.target.value })}
                    placeholder="e.g. Bosch, GE Monogram"
                    className="w-full rounded-lg border border-slate-200 bg-slate-50/50 px-3 py-1.5 text-xs font-bold text-slate-800 outline-none transition focus:border-[#531b7e] focus:bg-white focus:ring-1 focus:ring-[#531b7e]/20 disabled:opacity-50"
                />
            </section>

            <section>
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Finish</div>
                <div className="grid grid-cols-4 gap-1.5">
                    {FINISHES.map((f) => {
                        const selected = meta.finish === f.key;
                        return (
                            <button
                                key={f.key}
                                type="button"
                                onClick={() => write({ finish: f.key })}
                                title={f.label}
                                className={`flex flex-col items-stretch overflow-hidden rounded-lg border-2 transition shadow-sm ${
                                    selected ? "border-[#531b7e] ring-2 ring-[#531b7e]/20" : "border-slate-200 hover:border-slate-400"
                                }`}
                            >
                                <div
                                    className="h-6"
                                    style={{ backgroundColor: APPLIANCE_FINISH_COLORS[f.key] }}
                                />
                                <div className="bg-white py-1 text-[9px] font-semibold text-slate-600">{f.label}</div>
                            </button>
                        );
                    })}
                </div>
            </section>
        </div>
    );
}
