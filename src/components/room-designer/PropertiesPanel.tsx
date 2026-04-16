// Right sidebar. Stage 0 stub — shows selected asset metadata + a delete button.
// Stage 3 will grow this into a full cabinet/appliance configurator
// (hardware, finish, drawer layout, etc.).

import { useRoomStore } from "./hooks/useRoomStore";
import { getAsset } from "@/lib/room-designer/asset-registry";
import { WallBuilder } from "./WallBuilder";

const M_TO_IN = 39.3701;

function fmtInches(m: number): string {
    const totalIn = m * M_TO_IN;
    const ft = Math.floor(totalIn / 12);
    const inches = Math.round(totalIn - ft * 12);
    if (ft === 0) return `${inches}"`;
    return `${ft}' ${inches}"`;
}

export function PropertiesPanel() {
    const selectedAssetId = useRoomStore((s) => s.selectedAssetId);
    const assets = useRoomStore((s) => s.assets);
    const removeAsset = useRoomStore((s) => s.removeAsset);
    const selectAsset = useRoomStore((s) => s.selectAsset);

    const placed = selectedAssetId ? assets.find((a) => a.id === selectedAssetId) : null;
    const registry = placed ? getAsset(placed.assetId) : null;

    return (
        <aside className="flex h-full w-72 flex-col gap-4 overflow-y-auto border-l border-slate-200 bg-white p-4">
            <WallBuilder />

            <div className="border-t border-slate-100 pt-4">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Selected Item</h3>
                {!placed || !registry ? (
                    <p className="mt-2 text-sm text-slate-400">Click an item in the scene to inspect it.</p>
                ) : (
                    <div className="mt-2 space-y-3 text-sm">
                        <div>
                            <div className="font-medium text-slate-900">{registry.name}</div>
                            <div className="text-xs capitalize text-slate-500">
                                {registry.category} · {registry.subcategory}
                            </div>
                        </div>

                        <dl className="grid grid-cols-3 gap-2 rounded-md bg-slate-50 p-2 text-xs">
                            <div>
                                <dt className="text-slate-500">W</dt>
                                <dd className="font-medium">{fmtInches(registry.dimensions.width)}</dd>
                            </div>
                            <div>
                                <dt className="text-slate-500">H</dt>
                                <dd className="font-medium">{fmtInches(registry.dimensions.height)}</dd>
                            </div>
                            <div>
                                <dt className="text-slate-500">D</dt>
                                <dd className="font-medium">{fmtInches(registry.dimensions.depth)}</dd>
                            </div>
                        </dl>

                        {registry.tags.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                                {registry.tags.map((t) => (
                                    <span
                                        key={t}
                                        className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-600"
                                    >
                                        {t}
                                    </span>
                                ))}
                            </div>
                        )}

                        <button
                            onClick={() => {
                                removeAsset(placed.id);
                                selectAsset(null);
                            }}
                            className="hui-btn w-full border-red-200 bg-red-50 text-xs font-medium text-red-700 hover:border-red-300 hover:bg-red-100"
                        >
                            Delete Item
                        </button>
                    </div>
                )}
            </div>
        </aside>
    );
}
