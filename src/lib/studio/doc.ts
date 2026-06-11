// Room Studio - design document model + persistence mapping.
//
// The document is stored in RoomDesign.layoutJson (version: 2). Placed items
// are ALSO mirrored into RoomAsset rows so the rest of ProBuild can query
// them (estimates, selections). v1 rooms (the old room-designer) are upgraded
// on load - see `fromRoomRecord`.

import { feet, inches } from "./units";
import { DEFAULT_SURFACES, LEGACY_FINISH_MAP } from "./materials";
import { getItemDef } from "./catalog";

export interface Pt {
  x: number;
  z: number;
}

export interface PlacedItem {
  id: string;
  defId: string;
  /** Center of footprint on the floor plane, meters. */
  x: number;
  z: number;
  /** Bottom elevation override (wall cabinets, art height...). undefined = def default. */
  y?: number;
  /** Y-axis rotation, radians. 0 faces +Z (toward viewer at south). */
  rotation: number;
  /** Dimension overrides, meters. undefined = catalog default. */
  w?: number;
  d?: number;
  h?: number;
  /** Finish overrides per slot (slot -> finish id). */
  finishes?: Record<string, string>;
  /** Optional user label ("Pantry wall run"). */
  label?: string;
  /** LED strip on (items whose def has ledOption). */
  led?: boolean;
}

export interface RoomSlope {
  /** Wall index whose top edge drops to lowHeight; the opposite side keeps room.height. Rect rooms only. */
  lowWallIndex: number;
  lowHeight: number;
}

export interface DesignDoc {
  version: 2;
  room: {
    /** Closed simple polygon, clockwise when viewed from above (+Y), meters. */
    points: Pt[];
    height: number;
    wallThickness: number;
    /** Crown molding strip along the top of every level wall. */
    crown?: boolean;
    /** Slanted (shed) ceiling - only honored for 4-corner rectangular rooms. */
    slope?: RoomSlope;
  };
  surfaces: {
    floor: string;
    ceiling: string;
    /** Paint per wall index ("0", "1"...) with "all" fallback. */
    walls: Record<string, string>;
  };
  items: PlacedItem[];
  /** Saved camera (3D orbit). */
  camera?: { position: [number, number, number]; target: [number, number, number] };
}

export type RoomShape = "rect" | "l-shape";

export function makeRectRoom(widthM: number, lengthM: number, heightM = feet(9)): DesignDoc["room"] {
  const hw = widthM / 2;
  const hl = lengthM / 2;
  return {
    // Clockwise from NW corner (top-left in plan view, -X/-Z).
    points: [
      { x: -hw, z: -hl },
      { x: hw, z: -hl },
      { x: hw, z: hl },
      { x: -hw, z: hl },
    ],
    height: heightM,
    wallThickness: inches(5),
  };
}

export function makeLShapeRoom(widthM: number, lengthM: number, notchW: number, notchL: number, heightM = feet(9)): DesignDoc["room"] {
  const hw = widthM / 2;
  const hl = lengthM / 2;
  // Notch cut from the SE corner.
  return {
    points: [
      { x: -hw, z: -hl },
      { x: hw, z: -hl },
      { x: hw, z: hl - notchL },
      { x: hw - notchW, z: hl - notchL },
      { x: hw - notchW, z: hl },
      { x: -hw, z: hl },
    ],
    height: heightM,
    wallThickness: inches(5),
  };
}

export function emptyDoc(): DesignDoc {
  return {
    version: 2,
    room: makeRectRoom(feet(12), feet(10)),
    surfaces: {
      floor: DEFAULT_SURFACES.floor,
      ceiling: DEFAULT_SURFACES.ceiling,
      walls: { all: DEFAULT_SURFACES.wall },
    },
    items: [],
  };
}

let idCounter = 0;
export function newItemId(): string {
  idCounter += 1;
  return `pi-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

// ---------------------------------------------------------------------------
// Persistence mapping: DesignDoc <-> RoomDesign row (layoutJson + assets[])
// ---------------------------------------------------------------------------

/** Shape of a RoomAsset row as the API returns / accepts it. */
export interface ApiRoomAsset {
  id?: string;
  assetType: string;
  assetId: string;
  positionX: number;
  positionY: number;
  positionZ: number;
  rotationY: number;
  scaleX: number;
  scaleY: number;
  scaleZ: number;
  metadata?: Record<string, unknown> | null;
}

export interface ApiRoomRecord {
  id: string;
  name: string;
  roomType: string;
  layoutJson: unknown;
  assets?: ApiRoomAsset[];
  shareToken?: string | null;
  shareEnabled?: boolean;
}

export function toApiPayload(doc: DesignDoc): { layoutJson: DesignDoc; assets: ApiRoomAsset[] } {
  const assets: ApiRoomAsset[] = doc.items.map((it) => {
    const def = getItemDef(it.defId);
    return {
      assetType: def?.category ?? "decor",
      assetId: it.defId,
      positionX: it.x,
      positionY: it.y ?? 0,
      positionZ: it.z,
      rotationY: it.rotation,
      scaleX: 1,
      scaleY: 1,
      scaleZ: 1,
      metadata: {
        studio: {
          y: it.y,
          w: it.w,
          d: it.d,
          h: it.h,
          finishes: it.finishes,
          label: it.label,
          itemId: it.id,
        },
      },
    };
  });
  return { layoutJson: doc, assets };
}

interface V1Wall {
  start?: { x?: number; z?: number };
  end?: { x?: number; z?: number };
  height?: number;
}

interface V1Layout {
  dimensions?: { width?: number; length?: number; height?: number };
  walls?: V1Wall[];
  surfaces?: Record<string, string | null>;
}

function isV2(layout: unknown): layout is DesignDoc {
  return !!layout && typeof layout === "object" && (layout as { version?: number }).version === 2;
}

/** Build a DesignDoc from a saved RoomDesign row; upgrades v1 layouts. */
export function fromRoomRecord(record: ApiRoomRecord): DesignDoc {
  const layout = record.layoutJson;

  if (isV2(layout)) {
    // Items live canonically in layoutJson for v2; RoomAsset rows are a mirror.
    const doc = layout as DesignDoc;
    return {
      ...doc,
      items: Array.isArray(doc.items) ? doc.items : [],
    };
  }

  // ----- v1 upgrade -----
  const v1 = (layout ?? {}) as V1Layout;
  const dims = v1.dimensions ?? {};
  const width = clampNum(dims.width, feet(6), feet(60), feet(12));
  const length = clampNum(dims.length, feet(6), feet(60), feet(10));
  const height = clampNum(dims.height, feet(7), feet(20), feet(9));

  // makeRectRoom wall order: 0 = north, 1 = east, 2 = south, 3 = west.
  const walls: Record<string, string> = {
    all: upgradeFinish(v1.surfaces?.["wall-north"], DEFAULT_SURFACES.wall),
  };
  const V1_WALL_INDEX: Array<[string, number]> = [
    ["wall-north", 0],
    ["wall-east", 1],
    ["wall-south", 2],
    ["wall-west", 3],
  ];
  for (const [key, idx] of V1_WALL_INDEX) {
    const finish = v1.surfaces?.[key];
    if (finish) walls[String(idx)] = upgradeFinish(finish, DEFAULT_SURFACES.wall);
  }

  const doc: DesignDoc = {
    version: 2,
    room: makeRectRoom(width, length, height),
    surfaces: {
      floor: upgradeFinish(v1.surfaces?.floor, DEFAULT_SURFACES.floor),
      ceiling: DEFAULT_SURFACES.ceiling,
      walls,
    },
    items: [],
  };

  for (const a of record.assets ?? []) {
    const def = getItemDef(a.assetId);
    if (!def) continue; // unknown legacy asset - drop rather than render garbage
    const meta = (a.metadata ?? {}) as { studio?: Partial<PlacedItem> & { itemId?: string } };
    const studio = meta.studio ?? {};
    doc.items.push({
      id: studio.itemId ? String(studio.itemId) : newItemId(),
      defId: def.id,
      x: a.positionX ?? 0,
      z: a.positionZ ?? 0,
      y: studio.y ?? (a.positionY && a.positionY > 0.01 ? a.positionY : undefined),
      rotation: a.rotationY ?? 0,
      w: studio.w,
      d: studio.d,
      h: studio.h,
      finishes: studio.finishes,
      label: studio.label,
    });
  }

  return doc;
}

function upgradeFinish(id: string | null | undefined, fallback: string): string {
  if (!id) return fallback;
  return LEGACY_FINISH_MAP[id] ?? (id.startsWith("paint-") || id.startsWith("floor-") ? id : fallback);
}

function clampNum(v: unknown, min: number, max: number, dflt: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : dflt;
  return Math.min(max, Math.max(min, n));
}
