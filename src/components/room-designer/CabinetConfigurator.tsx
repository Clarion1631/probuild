// Cabinet configuration panel — rendered inside PropertiesPanel when the
// selected asset's category is "cabinet". Every change writes to
// metadata.cabinet.* through the store's `patchMetadata` helper.
//
// Width/height/depth chips write real meters, and AssetNode reads them back
// via resolveDimensions(), so the box geometry resizes live in the canvas.

import type {
    CabinetDoorStyle,
    CabinetFinishPreset,
    CabinetHardware,
    CabinetInterior,
    CabinetMeta,
    PlacedAsset,
} from "./types";
import { CABINET_FINISH_COLORS } from "@/lib/room-designer/asset-resolve";
import { useRoomStore } from "./hooks/useRoomStore";

const WIDTH_CHIPS: Array<{ label: string; meters: number }> = [
    { label: '9"', meters: 0.2286 },
    { label: '12"', meters: 0.3048 },
    { label: '15"', meters: 0.381 },
    { label: '18"', meters: 0.4572 },
    { label: '21"', meters: 0.5334 },
    { label: '24"', meters: 0.6096 },
    { label: '30"', meters: 0.762 },
    { label: '36"', meters: 0.9144 },
];

const HEIGHT_CHIPS: Array<{ label: string; meters: number }> = [
    { label: 'Short 30"', meters: 0.762 },
    { label: 'Standard 34.5"', meters: 0.876 },
    { label: 'Tall 42"', meters: 1.0668 },
];

const DEPTH_CHIPS: Array<{ label: string; meters: number }> = [
    { label: 'Shallow 12"', meters: 0.3048 },
    { label: 'Standard 24"', meters: 0.6096 },
];

const DOOR_STYLES: CabinetDoorStyle[] = ["shaker", "flat", "raised", "glass", "open"];
const HARDWARE: CabinetHardware[] = ["none", "bar-pull", "cup-pull", "knob", "edge-pull"];
const INTERIORS: CabinetInterior[] = ["standard", "drawer-org", "pullout", "lazy-susan", "trash"];

const FINISH_PRESETS: CabinetFinishPreset[] = [
    "white", "gray", "navy", "green", "wood", "walnut", "two-tone", "black", "cream",
];

function eqNum(a: number | undefined, b: number): boolean {
    if (a === undefined) return false;
    return Math.abs(a - b) < 0.0005;
}

interface CabinetConfiguratorProps {
    placed: PlacedAsset;
    refForFocus?: React.RefObject<HTMLInputElement | null>;
}

export function CabinetConfigurator({ placed, refForFocus }: CabinetConfiguratorProps) {
    const patchMetadata = useRoomStore((s) => s.patchMetadata);
    const meta = (placed.metadata?.cabinet ?? {}) as CabinetMeta;

    const writeCab = (patch: Partial<CabinetMeta>) =>
        patchMetadata(placed.id, "cabinet", patch as Record<string, unknown>);

    const isCustomFinish =
        typeof meta.finish === "string" &&
        !FINISH_PRESETS.includes(meta.finish as CabinetFinishPreset);

    return (
        <div className="space-y-3">
            <section>
                <Label>Width</Label>
                <ChipRow>
                    {WIDTH_CHIPS.map((c) => (
                        <Chip
                            key={c.label}
                            selected={eqNum(meta.width, c.meters)}
                            onClick={() => writeCab({ width: c.meters })}
                            innerRef={refForFocus && c === WIDTH_CHIPS[0] ? undefined : undefined}
                        >
                            {c.label}
                        </Chip>
                    ))}
                </ChipRow>
            </section>

            <section>
                <Label>Height</Label>
                <ChipRow>
                    {HEIGHT_CHIPS.map((c) => (
                        <Chip
                            key={c.label}
                            selected={eqNum(meta.height, c.meters)}
                            onClick={() => writeCab({ height: c.meters })}
                        >
                            {c.label}
                        </Chip>
                    ))}
                </ChipRow>
            </section>

            <section>
                <Label>Depth</Label>
                <ChipRow>
                    {DEPTH_CHIPS.map((c) => (
                        <Chip
                            key={c.label}
                            selected={eqNum(meta.depth, c.meters)}
                            onClick={() => writeCab({ depth: c.meters })}
                        >
                            {c.label}
                        </Chip>
                    ))}
                </ChipRow>
            </section>

            <section>
                <Label>Door Style</Label>
                <ChipRow>
                    {DOOR_STYLES.map((s) => (
                        <Chip
                            key={s}
                            selected={meta.doorStyle === s}
                            onClick={() => writeCab({ doorStyle: s })}
                        >
                            {cap(s)}
                        </Chip>
                    ))}
                </ChipRow>
            </section>

            <section>
                <Label>Finish</Label>
                <div className="grid grid-cols-5 gap-1.5">
                    {FINISH_PRESETS.map((f) => {
                        const hex = CABINET_FINISH_COLORS[f];
                        const selected = meta.finish === f;
                        return (
                            <button
                                key={f}
                                type="button"
                                onClick={() => writeCab({ finish: f })}
                                title={cap(f)}
                                aria-label={f}
                                className={`h-8 rounded border-2 transition ${
                                    selected ? "border-blue-500 ring-1 ring-blue-200" : "border-slate-200 hover:border-slate-400"
                                }`}
                                style={{ backgroundColor: hex }}
                            />
                        );
                    })}
                    <label
                        title="Custom color"
                        className={`relative flex h-8 items-center justify-center rounded border-2 text-[10px] font-medium transition ${
                            isCustomFinish ? "border-blue-500 ring-1 ring-blue-200" : "border-slate-200 hover:border-slate-400"
                        }`}
                        style={
                            isCustomFinish
                                ? { backgroundColor: meta.finish as string }
                                : { backgroundColor: "white" }
                        }
                    >
                        +
                        <input
                            type="color"
                            value={isCustomFinish ? (meta.finish as string) : "#c9a06b"}
                            onChange={(e) => writeCab({ finish: e.target.value })}
                            className="absolute inset-0 cursor-pointer opacity-0"
                        />
                    </label>
                </div>
            </section>

            <section>
                <Label>Hardware</Label>
                <ChipRow>
                    {HARDWARE.map((h) => (
                        <Chip
                            key={h}
                            selected={meta.hardware === h}
                            onClick={() => writeCab({ hardware: h })}
                        >
                            {cap(h)}
                        </Chip>
                    ))}
                </ChipRow>
            </section>

            <section>
                <Label>Interior</Label>
                <ChipRow>
                    {INTERIORS.map((i) => (
                        <Chip
                            key={i}
                            selected={meta.interior === i}
                            onClick={() => writeCab({ interior: i })}
                        >
                            {cap(i)}
                        </Chip>
                    ))}
                </ChipRow>
            </section>
        </div>
    );
}

function cap(s: string): string {
    return s
        .split("-")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
}

function Label({ children }: { children: React.ReactNode }) {
    return <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">{children}</div>;
}

function ChipRow({ children }: { children: React.ReactNode }) {
    return <div className="flex flex-wrap gap-1">{children}</div>;
}

function Chip({
    selected,
    onClick,
    children,
    innerRef,
}: {
    selected: boolean;
    onClick: () => void;
    children: React.ReactNode;
    innerRef?: React.Ref<HTMLButtonElement>;
}) {
    return (
        <button
            type="button"
            ref={innerRef}
            onClick={onClick}
            className={`rounded border px-1.5 py-0.5 text-[11px] transition ${
                selected
                    ? "border-slate-900 bg-slate-900 text-white"
                    : "border-slate-200 bg-white text-slate-700 hover:border-slate-400"
            }`}
        >
            {children}
        </button>
    );
}
