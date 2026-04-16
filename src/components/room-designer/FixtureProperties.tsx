// Fixture-specific metadata editor. 5 hardware finish swatches.

import type { FixtureFinish, FixtureMeta, PlacedAsset } from "./types";
import { FIXTURE_FINISH_COLORS } from "@/lib/room-designer/asset-resolve";
import { useRoomStore } from "./hooks/useRoomStore";

const FINISHES: Array<{ key: FixtureFinish; label: string }> = [
    { key: "chrome", label: "Chrome" },
    { key: "brushed-nickel", label: "Brushed Nickel" },
    { key: "matte-black", label: "Matte Black" },
    { key: "oil-bronze", label: "Oil Bronze" },
    { key: "brass", label: "Brass" },
];

interface FixtureProps {
    placed: PlacedAsset;
}

export function FixtureProperties({ placed }: FixtureProps) {
    const patchMetadata = useRoomStore((s) => s.patchMetadata);
    const meta = (placed.metadata?.fixture ?? {}) as FixtureMeta;

    const write = (patch: Partial<FixtureMeta>) =>
        patchMetadata(placed.id, "fixture", patch as Record<string, unknown>);

    return (
        <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Finish</div>
            <div className="grid grid-cols-5 gap-1.5">
                {FINISHES.map((f) => {
                    const selected = meta.finish === f.key;
                    return (
                        <button
                            key={f.key}
                            type="button"
                            onClick={() => write({ finish: f.key })}
                            title={f.label}
                            aria-label={f.label}
                            className={`h-8 rounded border-2 transition ${
                                selected ? "border-blue-500 ring-1 ring-blue-200" : "border-slate-200 hover:border-slate-400"
                            }`}
                            style={{ backgroundColor: FIXTURE_FINISH_COLORS[f.key] }}
                        />
                    );
                })}
            </div>
        </div>
    );
}
