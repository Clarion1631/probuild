"use client";

// Room Studio - left panel: object catalog + paint + flooring.

import { useMemo, useState } from "react";
import {
  Search, RefrigeratorIcon, Lamp, DoorOpen, Sofa, Flower2, Grid2x2, Paintbrush,
  Layers, ShowerHead, TreePine, X,
} from "lucide-react";
import {
  CATALOG, CATEGORY_LABELS, CATEGORY_ORDER, getLibraryProducts,
  type CatalogItem, type Category,
} from "@/lib/studio/catalog";
import {
  PAINTS, SW_PAINTS, FLOORS, COUNTERS, CABINET_FINISHES, getFinish,
  getLibraryFinishesByKind,
} from "@/lib/studio/materials";
import { formatIn, formatFtIn } from "@/lib/studio/units";
import { useStudio } from "../store";
import { useLibrary } from "../useLibrary";
import { useItemThumbnail } from "./thumbnails";

type Tab = "items" | "paint" | "floors";

const CATEGORY_ICONS: Record<Category, React.ReactNode> = {
  cabinets: <Grid2x2 className="h-4 w-4" />,
  appliances: <RefrigeratorIcon className="h-4 w-4" />,
  fixtures: <ShowerHead className="h-4 w-4" />,
  lighting: <Lamp className="h-4 w-4" />,
  "doors-windows": <DoorOpen className="h-4 w-4" />,
  furniture: <Sofa className="h-4 w-4" />,
  outdoor: <TreePine className="h-4 w-4" />,
  decor: <Flower2 className="h-4 w-4" />,
};

export function CatalogPanel() {
  const [tab, setTab] = useState<Tab>("items");
  const [category, setCategory] = useState<Category>("cabinets");
  const [query, setQuery] = useState("");
  const placing = useStudio((s) => s.placing);
  const setPlacing = useStudio((s) => s.setPlacing);
  const library = useLibrary();

  const items = useMemo(() => {
    // Library products (real vendor SKUs) list ahead of the seeded items.
    const all = [...getLibraryProducts(), ...CATALOG];
    const q = query.trim().toLowerCase();
    if (!q) return all.filter((c) => c.category === category);
    return all.filter(
      (c) => c.name.toLowerCase().includes(q) || c.tags?.some((t) => t.toLowerCase().includes(q)),
    );
    // library is in deps so the list refreshes once products register
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, query, library]);

  return (
    <div className="flex h-full w-[280px] shrink-0 flex-col border-r border-slate-200 bg-white">
      {/* tabs */}
      <div className="flex border-b border-slate-200">
        {([
          ["items", "Objects", <Layers key="i" className="h-3.5 w-3.5" />],
          ["paint", "Paint", <Paintbrush key="p" className="h-3.5 w-3.5" />],
          ["floors", "Floors", <Grid2x2 key="f" className="h-3.5 w-3.5" />],
        ] as Array<[Tab, string, React.ReactNode]>).map(([t, label, icon]) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex flex-1 items-center justify-center gap-1.5 py-2.5 text-xs font-semibold transition-colors ${
              tab === t ? "border-b-2 border-blue-600 text-blue-700" : "text-slate-500 hover:text-slate-800"
            }`}
          >
            {icon}
            {label}
          </button>
        ))}
      </div>

      {tab === "items" && (
        <>
          <div className="p-2.5">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search cabinets, sofa, pergola..."
                className="w-full rounded-lg border border-slate-200 bg-slate-50 py-2 pl-8 pr-7 text-xs outline-none focus:border-blue-400 focus:bg-white"
              />
              {query && (
                <button onClick={() => setQuery("")} className="absolute right-2 top-2 text-slate-400 hover:text-slate-700">
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>

          {!query && (
            <div className="flex flex-wrap gap-1 px-2.5 pb-2">
              {CATEGORY_ORDER.map((c) => (
                <button
                  key={c}
                  onClick={() => setCategory(c)}
                  title={CATEGORY_LABELS[c]}
                  className={`flex items-center gap-1 rounded-md px-2 py-1.5 text-[11px] font-medium transition-colors ${
                    category === c ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                  }`}
                >
                  {CATEGORY_ICONS[c]}
                  <span className="hidden xl:inline">{CATEGORY_LABELS[c].split(" ")[0]}</span>
                </button>
              ))}
            </div>
          )}

          <div className="grid flex-1 auto-rows-min grid-cols-2 gap-2 overflow-y-auto p-2.5 pt-1">
            {items.map((item) => (
              <ItemCard
                key={item.id}
                item={item}
                active={placing?.id === item.id}
                onClick={() => setPlacing(placing?.id === item.id ? null : item)}
              />
            ))}
            {items.length === 0 && (
              <div className="col-span-2 py-8 text-center text-xs text-slate-400">No matches</div>
            )}
          </div>

          {placing && (
            <div className="border-t border-blue-100 bg-blue-50 px-3 py-2 text-[11px] leading-snug text-blue-800">
              Click in the room to place <b>{placing.name}</b>. Hold <b>Shift</b> to place several. <b>Esc</b> cancels.
            </div>
          )}
        </>
      )}

      {tab === "paint" && <PaintTab />}
      {tab === "floors" && <FloorsTab />}
    </div>
  );
}

function ItemCard({ item, active, onClick }: { item: CatalogItem; active: boolean; onClick: () => void }) {
  const thumb = useItemThumbnail(item);
  const isLibrary = item.id.startsWith("prod-");
  const product = useLibraryProductInfo(isLibrary ? item.id.slice(5) : null);
  const accent = item.finishes
    ? getFinish(item.finishes.cabinet ?? item.finishes.fabric ?? item.finishes.wood ?? item.finishes.metal ?? Object.values(item.finishes)[0], "cab-white").hex
    : "#cbd5e1";
  return (
    <button
      onClick={onClick}
      className={`group relative flex flex-col items-stretch rounded-xl border p-2 text-left transition-all ${
        active
          ? "border-blue-500 bg-blue-50 shadow-sm ring-2 ring-blue-200"
          : "border-slate-200 bg-white hover:border-slate-300 hover:shadow-sm"
      }`}
    >
      {isLibrary && (
        <span className="absolute right-1.5 top-1.5 z-10 rounded bg-emerald-600 px-1 py-0.5 text-[8px] font-bold uppercase tracking-wide text-white">
          Yours
        </span>
      )}
      <div
        className="mb-1.5 flex h-16 items-center justify-center overflow-hidden rounded-lg"
        style={{ background: `linear-gradient(150deg, ${accent}1f, ${accent}4d)` }}
      >
        {thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumb} alt={item.name} className="h-full w-full object-contain" draggable={false} />
        ) : (
          <span className="text-slate-600">{CATEGORY_ICONS[item.category]}</span>
        )}
      </div>
      <span className="truncate text-[11px] font-semibold text-slate-800">{item.name}</span>
      <span className="truncate text-[10px] text-slate-400">
        {item.w >= 0.9 ? formatFtIn(item.w) : formatIn(item.w)} w
        {product?.vendor ? ` - ${product.vendor}` : ""}
        {product?.price != null ? ` - $${product.price.toLocaleString()}` : ""}
      </span>
    </button>
  );
}

function useLibraryProductInfo(id: string | null) {
  const library = useLibrary();
  return id ? library.products.find((p) => p.id === id) ?? null : null;
}

function PaintTab() {
  const activeSurface = useStudio((s) => s.activeSurface);
  const setWallPaint = useStudio((s) => s.setWallPaint);
  const doc = useStudio((s) => s.doc);

  const targetLabel =
    activeSurface?.kind === "wall" ? `Wall ${activeSurface.wallIndex + 1}` : "All walls";
  const currentId =
    activeSurface?.kind === "wall"
      ? doc.surfaces.walls[String(activeSurface.wallIndex)] ?? doc.surfaces.walls.all
      : doc.surfaces.walls.all;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="border-b border-slate-100 px-3 py-2.5">
        <div className="text-[11px] font-semibold text-slate-700">
          Painting: <span className="text-blue-700">{targetLabel}</span>
        </div>
        <div className="mt-0.5 text-[10.5px] leading-snug text-slate-400">
          Click a wall in the room to paint just that wall, or pick a color now for every wall.
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        <PaintSections
          currentId={currentId}
          onPick={(id) => setWallPaint(activeSurface?.kind === "wall" ? activeSurface.wallIndex : "all", id)}
        />
      </div>
    </div>
  );
}

/** Studio palette + Sherwin-Williams + the org's own library paints. */
export function PaintSections({ currentId, onPick }: { currentId?: string; onPick: (id: string) => void }) {
  useLibrary();
  const libraryPaints = getLibraryFinishesByKind("paint");
  return (
    <div className="space-y-3">
      {libraryPaints.length > 0 && (
        <div>
          <SectionLabel>Your library</SectionLabel>
          <div className="mt-1 grid grid-cols-4 gap-1.5">
            {libraryPaints.map((p) => (
              <Swatch key={p.id} hex={p.hex} name={p.name} selected={currentId === p.id} onClick={() => onPick(p.id)} />
            ))}
          </div>
        </div>
      )}
      <div>
        <SectionLabel>Studio palette</SectionLabel>
        <div className="mt-1 grid grid-cols-4 gap-1.5">
          {PAINTS.map((p) => (
            <Swatch key={p.id} hex={p.hex} name={p.name} selected={currentId === p.id} onClick={() => onPick(p.id)} />
          ))}
        </div>
      </div>
      <div>
        <SectionLabel>Sherwin-Williams</SectionLabel>
        <div className="mt-1 grid grid-cols-4 gap-1.5">
          {SW_PAINTS.map((p) => (
            <Swatch key={p.id} hex={p.hex} name={p.name} selected={currentId === p.id} onClick={() => onPick(p.id)} />
          ))}
        </div>
        <div className="mt-1 text-[9.5px] leading-snug text-slate-400">
          Screen approximations - confirm with physical chips.
        </div>
      </div>
    </div>
  );
}

function FloorsTab() {
  const doc = useStudio((s) => s.doc);
  const setFloorFinish = useStudio((s) => s.setFloorFinish);
  const commitDoc = useStudio((s) => s.commitDoc);
  useLibrary();
  const libFloors = getLibraryFinishesByKind("floor");
  const libCounters = getLibraryFinishesByKind("counter");
  const libCabinets = getLibraryFinishesByKind("cabinet");

  const applyCounterAll = (finishId: string) => {
    const items = doc.items.map((it) => {
      const finishes = { ...it.finishes };
      // only items that expose a counter slot
      const hasCounter = it.defId.startsWith("base-") || it.defId.startsWith("island") || it.defId.startsWith("vanity") || it.defId === "dishwasher" || it.defId === "wine-fridge";
      if (!hasCounter) return it;
      return { ...it, finishes: { ...finishes, counter: finishId } };
    });
    commitDoc({ ...doc, items });
  };

  const applyCabinetAll = (finishId: string) => {
    const items = doc.items.map((it) => {
      const isCab = it.defId.startsWith("base-") || it.defId.startsWith("wall-cab") || it.defId.startsWith("pantry") || it.defId.startsWith("oven-tower") || it.defId.startsWith("vanity");
      if (!isCab) return it;
      return { ...it, finishes: { ...it.finishes, cabinet: finishId } };
    });
    commitDoc({ ...doc, items });
  };

  return (
    <div className="flex flex-1 flex-col gap-1 overflow-y-auto p-3">
      <SectionLabel>Flooring</SectionLabel>
      <div className="grid grid-cols-4 gap-1.5">
        {[...libFloors, ...FLOORS].map((f) => (
          <Swatch key={f.id} hex={f.hex} name={f.name} selected={doc.surfaces.floor === f.id} onClick={() => setFloorFinish(f.id)} />
        ))}
      </div>
      <SectionLabel className="mt-3">Countertops - apply to all</SectionLabel>
      <div className="grid grid-cols-4 gap-1.5">
        {[...libCounters, ...COUNTERS].map((f) => (
          <Swatch key={f.id} hex={f.hex} name={f.name} onClick={() => applyCounterAll(f.id)} />
        ))}
      </div>
      <SectionLabel className="mt-3">Cabinet color - apply to all</SectionLabel>
      <div className="grid grid-cols-4 gap-1.5">
        {[...libCabinets, ...CABINET_FINISHES].map((f) => (
          <Swatch key={f.id} hex={f.hex} name={f.name} onClick={() => applyCabinetAll(f.id)} />
        ))}
      </div>
      <div className="mt-2 text-[10.5px] leading-snug text-slate-400">
        Countertop and cabinet colors can also be changed per piece - select any cabinet in the room.
      </div>
    </div>
  );
}

function SectionLabel({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`text-[11px] font-bold uppercase tracking-wide text-slate-500 ${className}`}>{children}</div>;
}

export function Swatch({ hex, name, selected, onClick }: { hex: string; name: string; selected?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={name}
      className={`group relative flex flex-col items-center gap-1 rounded-lg p-1 transition-all hover:bg-slate-100 ${selected ? "bg-blue-50 ring-2 ring-blue-400" : ""}`}
    >
      <span
        className="block h-9 w-full rounded-md border border-black/10 shadow-inner"
        style={{ backgroundColor: hex }}
      />
      <span className="w-full truncate text-center text-[9px] leading-tight text-slate-500">{name}</span>
    </button>
  );
}
