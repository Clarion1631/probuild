// W/H/D dimension pill — small purple capsule with axis label + integer inches.
// Today the JSX lives inline in AssetCard; this component is the canonical form
// so the same visual appears in the selection HUD and any future asset surface.

interface DimensionPillProps {
    axis: "W" | "H" | "D";
    inches: number;
    className?: string;
}

export function DimensionPill({ axis, inches, className = "" }: DimensionPillProps) {
    return (
        <span
            className={`inline-flex items-center justify-center rounded border border-purple-100/50 bg-purple-50 px-1.5 py-0.5 text-[9px] font-bold text-purple-600 ${className}`}
        >
            {axis} <span className="ml-1 text-purple-400">{inches}</span>
        </span>
    );
}
