"use client";

// Room Studio - placed items: rendering, selection, drag-move with snapping,
// rotate handle. Dragging mutates the three.js group directly and commits to
// the store on release - zero React renders per frame.

import * as THREE from "three";
import { useMemo, useRef, useCallback } from "react";
import { Html } from "@react-three/drei";
import type { ThreeEvent } from "@react-three/fiber";
import type { DesignDoc, PlacedItem } from "@/lib/studio/doc";
import { getItemDef, type CatalogItem } from "@/lib/studio/catalog";
import {
  wallSegments, nearestWall, wallFacingRotation, snapToNeighbors,
  pointInPolygon, roomHeightAt, type WallSeg, type OBB, type RoomShellInfo,
} from "@/lib/studio/geometry";
import { inches, formatFtIn } from "@/lib/studio/units";
import { deckTopYAt, isDeckPlatform } from "@/lib/studio/stacking";
import { useStudio } from "../store";
import { useLibrary } from "../useLibrary";
import { BUILDERS } from "./builders";

const CLICK_SLOP_PX = 5;
const GRID = inches(1);
const WALL_SNAP_DIST = 0.4; // pull-to-wall radius, meters
const NEIGHBOR_SNAP = inches(5);
const MAX_REAL_LIGHTS = 8;

export interface ResolvedItem {
  item: PlacedItem;
  def: CatalogItem;
  w: number;
  d: number;
  h: number;
  y: number;
  finishes: Record<string, string | undefined>;
}

export function resolveItem(item: PlacedItem): ResolvedItem | null {
  const def = getItemDef(item.defId);
  if (!def) return null;
  return {
    item,
    def,
    w: item.w ?? def.w,
    d: item.d ?? def.d,
    h: item.h ?? def.h,
    y: item.y ?? def.elevation ?? 0,
    finishes: { ...def.finishes, ...item.finishes },
  };
}


interface DragState {
  pointerId: number;
  moved: boolean;
  /** Pointer-to-item offset on the drag plane, so items don't jump to cursor. */
  offX: number;
  offZ: number;
  /** Plane point at pointer-down; movement under DRAG_START_M is click jitter. */
  startX: number;
  startZ: number;
  cur: { x: number; z: number; rotation: number };
}

/** Pointer must travel this far on the floor plane before a drag begins. */
const DRAG_START_M = 0.015;

export function Items({ doc }: { doc: DesignDoc }) {
  // re-render when the product library registers (library defIds resolve late)
  useLibrary();
  const walls = useMemo(() => wallSegments(doc.room.points), [doc.room.points]);
  const shell: RoomShellInfo = useMemo(
    () => ({ points: doc.room.points, height: doc.room.height, slope: doc.room.slope }),
    [doc.room.points, doc.room.height, doc.room.slope],
  );

  // Cap real point lights for perf; remaining emitters stay emissive-only.
  const lightItemIds = useMemo(() => {
    const ids = new Set<string>();
    let budget = MAX_REAL_LIGHTS;
    for (const item of doc.items) {
      if (budget <= 0) break;
      const def = getItemDef(item.defId);
      if (def?.emitsLight) {
        ids.add(item.id);
        budget -= 1;
      }
    }
    return ids;
  }, [doc.items]);

  return (
    <group>
      {doc.items.map((item) => {
        const r = resolveItem(item);
        if (!r) return null;
        return (
          <ItemNode
            key={item.id}
            resolved={r}
            walls={walls}
            roomPoints={doc.room.points}
            allItems={doc.items}
            shell={shell}
            allowLight={lightItemIds.has(item.id)}
            wallThickness={doc.room.wallThickness}
          />
        );
      })}
    </group>
  );
}

function ItemNode({
  resolved, walls, roomPoints, allItems, shell, allowLight, wallThickness,
}: {
  resolved: ResolvedItem;
  walls: WallSeg[];
  roomPoints: DesignDoc["room"]["points"];
  allItems: PlacedItem[];
  shell: RoomShellInfo;
  allowLight: boolean;
  wallThickness: number;
}) {
  const { item, def, w, d, finishes } = resolved;
  // Interior walls always stretch to the ceiling at their position.
  const h = def.fullHeight
    ? roomHeightAt(shell, { x: item.x, z: item.z }) - 0.01
    : resolved.h;
  const selected = useStudio((s) => s.selectedId === item.id);
  const presentMode = useStudio((s) => s.presentMode);
  const lightsOn = useStudio((s) => s.lightsOn);
  const view = useStudio((s) => s.view);

  const groupRef = useRef<THREE.Group>(null);
  const dragRef = useRef<DragState | null>(null);

  // Ceiling items hang from the (possibly sloped) ceiling at their position.
  const baseY = def.mount === "ceiling"
    ? roomHeightAt(shell, { x: item.x, z: item.z }) - h
    : resolved.y;

  const Builder = BUILDERS[def.mesh];

  // Doors/windows/niches belong to a wall - tag them so DollhouseSync hides
  // them together with the wall they sit in.
  const hostWallIndex = useMemo(() => {
    if (def.category !== "doors-windows" && !def.cutsWall) return undefined;
    const hit = nearestWall({ x: item.x, z: item.z }, walls);
    return hit && hit.distance < 0.4 ? hit.wall.index : undefined;
  }, [def, item.x, item.z, walls]);

  const obbOthers = useMemo(() => {
    if (!def.wallSnap && def.category !== "cabinets") return [];
    return allItems
      .filter((o) => o.id !== item.id)
      .map((o) => {
        const ro = resolveItem(o);
        if (!ro || ro.def.mount !== def.mount) return null;
        return { cx: o.x, cz: o.z, hw: ro.w / 2, hd: ro.d / 2, rot: o.rotation } as OBB;
      })
      .filter(Boolean) as OBB[];
  }, [allItems, item.id, def]);

  const planeY = def.mount === "wall" || def.mount === "ceiling" ? 0 : baseY;

  const intersectPlane = useCallback((ray: THREE.Ray, y: number): { x: number; z: number } | null => {
    const dy = ray.direction.y;
    if (Math.abs(dy) < 1e-6) return null;
    const t = (y - ray.origin.y) / dy;
    if (t < 0) return null;
    return { x: ray.origin.x + ray.direction.x * t, z: ray.origin.z + ray.direction.z * t };
  }, []);

  const applySnaps = useCallback((px: number, pz: number): { x: number; z: number; rotation: number } => {
    let x = px;
    let z = pz;
    let rotation = dragRef.current?.cur.rotation ?? item.rotation;

    if (def.mount === "wall") {
      // Wall items slide along the nearest wall, always flush. Items that cut
      // into the wall (doors, windows, niches) center on the wall face.
      const hit = nearestWall({ x, z }, walls);
      if (hit) {
        rotation = wallFacingRotation(hit.wall);
        const off = def.category === "doors-windows" || def.cutsWall ? 0 : d / 2;
        // Clamp t so the item stays within the wall span.
        const halfFrac = (w / 2) / hit.wall.length;
        const t = Math.min(1 - halfFrac, Math.max(halfFrac, hit.t));
        x = hit.wall.a.x + hit.wall.dir.x * hit.wall.length * t + hit.wall.normal.x * off;
        z = hit.wall.a.z + hit.wall.dir.z * hit.wall.length * t + hit.wall.normal.z * off;
        return { x, z, rotation };
      }
    }

    // grid snap
    x = Math.round(x / GRID) * GRID;
    z = Math.round(z / GRID) * GRID;

    // floor items with wallSnap: glue back edge to a near wall
    if (def.wallSnap && def.mount === "floor") {
      const hit = nearestWall({ x, z }, walls);
      if (hit && hit.distance < d / 2 + WALL_SNAP_DIST) {
        rotation = wallFacingRotation(hit.wall);
        const halfFrac = (w / 2) / hit.wall.length;
        const t = Math.min(1 - halfFrac, Math.max(halfFrac, hit.t));
        x = hit.wall.a.x + hit.wall.dir.x * hit.wall.length * t + hit.wall.normal.x * (d / 2);
        z = hit.wall.a.z + hit.wall.dir.z * hit.wall.length * t + hit.wall.normal.z * (d / 2);
      }
    }

    // neighbor magnetism (cabinet runs, side-by-side appliances)
    if (obbOthers.length && (def.category === "cabinets" || def.category === "appliances")) {
      const snapped = snapToNeighbors({ cx: x, cz: z, hw: w / 2, hd: d / 2, rot: rotation }, obbOthers, NEIGHBOR_SNAP);
      if (snapped) {
        x = snapped.cx;
        z = snapped.cz;
      }
    }

    // keep center inside the room
    if (!pointInPolygon({ x, z }, roomPoints)) {
      return { x: dragRef.current?.cur.x ?? item.x, z: dragRef.current?.cur.z ?? item.z, rotation };
    }

    return { x, z, rotation };
  }, [def, w, d, walls, obbOthers, roomPoints, item.rotation, item.x, item.z]);

  const onPointerDown = (e: ThreeEvent<PointerEvent>) => {
    if (presentMode || view === "walk") return;
    if (e.button !== 0) return;
    if (useStudio.getState().placing) return;
    e.stopPropagation();
    try {
      (e.target as Element).setPointerCapture(e.pointerId);
    } catch {
      // synthetic events (tests) have no active pointer to capture
    }
    dragRef.current = {
      pointerId: e.pointerId,
      moved: false,
      offX: 0,
      offZ: 0,
      startX: 0,
      startZ: 0,
      cur: { x: item.x, z: item.z, rotation: item.rotation },
    };
    const p = intersectPlane(e.ray, planeY);
    if (p) {
      dragRef.current.offX = item.x - p.x;
      dragRef.current.offZ = item.z - p.z;
      dragRef.current.startX = p.x;
      dragRef.current.startZ = p.z;
    }
    useStudio.getState().select(item.id);
  };

  const onPointerMove = (e: ThreeEvent<PointerEvent>) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    const p = intersectPlane(e.ray, planeY);
    if (!p) return;
    if (!drag.moved) {
      // ignore click jitter - selection clicks shouldn't start a drag
      if (Math.hypot(p.x - drag.startX, p.z - drag.startZ) < DRAG_START_M) return;
      drag.moved = true;
      useStudio.getState().setDragging(true);
    }
    const next = applySnaps(p.x + drag.offX, p.z + drag.offZ);
    drag.cur = next;
    const g = groupRef.current;
    if (g) {
      g.position.x = next.x;
      g.position.z = next.z;
      g.rotation.y = next.rotation;
    }
  };

  const endDrag = (e: ThreeEvent<PointerEvent>) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    dragRef.current = null;
    try {
      (e.target as Element).releasePointerCapture(e.pointerId);
    } catch {
      // pointer already released
    }
    if (drag.moved) {
      useStudio.getState().setDragging(false);
      // No-op commits (snapped back to the start) shouldn't dirty the doc
      // or burn an undo step.
      const changed =
        Math.abs(drag.cur.x - item.x) > 1e-6 ||
        Math.abs(drag.cur.z - item.z) > 1e-6 ||
        Math.abs(drag.cur.rotation - item.rotation) > 1e-6;
      if (changed) {
        const patch: Partial<PlacedItem> = {
          x: drag.cur.x,
          z: drag.cur.z,
          rotation: drag.cur.rotation,
        };
        // Deck auto-stack: floor items ride on top of a deck platform they
        // land on and drop back to the floor when dragged off. Wall/ceiling/
        // counter mounts and the decks themselves keep their own y.
        if (def.mount === "floor" && !isDeckPlatform(def.id)) {
          patch.y = deckTopYAt(allItems, { x: drag.cur.x, z: drag.cur.z }, item.id);
        }
        useStudio.getState().updateItem(item.id, patch);
      } else {
        // restore the transient three.js pose to the committed one
        const g = groupRef.current;
        if (g) {
          g.position.x = item.x;
          g.position.z = item.z;
          g.rotation.y = item.rotation;
        }
      }
    }
  };

  if (!Builder) return null;

  return (
    <group
      ref={groupRef}
      position={[item.x, baseY, item.z]}
      rotation={[0, item.rotation, 0]}
      userData={hostWallIndex !== undefined ? { wallIndex: hostWallIndex } : undefined}
    >
      <group
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClick={(e) => {
          // While placing, stay transparent so the capture plane gets the click.
          if (useStudio.getState().placing) return;
          if (e.delta > CLICK_SLOP_PX) return;
          e.stopPropagation();
        }}
      >
        <Builder
          w={w}
          // recessed items can't be deeper than the wall they cut into
          d={def.cutsWall ? Math.min(d, wallThickness - 0.02) : d}
          h={h}
          finishes={finishes}
          lightsOn={lightsOn}
          led={!!item.led}
        />
      </group>

      {/* real light for emitters within budget */}
      {allowLight && def.emitsLight && lightsOn && def.category === "lighting" && (
        <pointLight
          position={[0, def.mount === "ceiling" ? Math.max(0.1, h * 0.3) : h * 0.8, 0]}
          intensity={0.55}
          distance={4.5}
          decay={1.8}
          color="#ffe7c0"
        />
      )}

      {/* selection footprint + rotate handle + dims label */}
      {selected && !presentMode && (
        <SelectionChrome
          itemId={item.id}
          w={w}
          d={d}
          baseY={def.mount === "wall" || def.mount === "ceiling" ? -baseY + 0.01 : 0.01}
          label={`${def.name} - ${formatFtIn(w)} x ${formatFtIn(d)}`}
          groupRef={groupRef}
          intersectPlane={intersectPlane}
        />
      )}
    </group>
  );
}

/** Selection outline at floor level + drag-to-rotate handle. */
function SelectionChrome({
  itemId, w, d, baseY, label, groupRef, intersectPlane,
}: {
  itemId: string;
  w: number;
  d: number;
  baseY: number;
  label: string;
  groupRef: React.RefObject<THREE.Group | null>;
  intersectPlane: (ray: THREE.Ray, y: number) => { x: number; z: number } | null;
}) {
  const pad = 0.06;
  const hw = w / 2 + pad;
  const hd = d / 2 + pad;
  const rotDrag = useRef<{ pointerId: number; start: number } | null>(null);

  const onRotDown = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    try {
      (e.target as Element).setPointerCapture(e.pointerId);
    } catch {
      // synthetic events (tests) have no active pointer to capture
    }
    rotDrag.current = { pointerId: e.pointerId, start: 0 };
    useStudio.getState().setDragging(true);
  };

  const onRotMove = (e: ThreeEvent<PointerEvent>) => {
    const rd = rotDrag.current;
    if (!rd || e.pointerId !== rd.pointerId) return;
    const g = groupRef.current;
    if (!g) return;
    const p = intersectPlane(e.ray, 0);
    if (!p) return;
    let angle = Math.atan2(p.x - g.position.x, p.z - g.position.z);
    // 15-degree steps
    const step = Math.PI / 12;
    angle = Math.round(angle / step) * step;
    g.rotation.y = angle;
  };

  const onRotUp = (e: ThreeEvent<PointerEvent>) => {
    const rd = rotDrag.current;
    if (!rd || e.pointerId !== rd.pointerId) return;
    rotDrag.current = null;
    try {
      (e.target as Element).releasePointerCapture(e.pointerId);
    } catch {
      // already released
    }
    useStudio.getState().setDragging(false);
    const g = groupRef.current;
    if (g) useStudio.getState().updateItem(itemId, { rotation: g.rotation.y });
  };

  return (
    <group position={[0, baseY, 0]}>
      {/* outline */}
      <lineSegments raycast={() => null}>
        <edgesGeometry args={[new THREE.PlaneGeometry(hw * 2, hd * 2).rotateX(-Math.PI / 2)]} />
        <lineBasicMaterial color="#2563eb" />
      </lineSegments>
      {/* soft fill */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.002, 0]} raycast={() => null}>
        <planeGeometry args={[hw * 2, hd * 2]} />
        <meshBasicMaterial color="#3b82f6" transparent opacity={0.08} depthWrite={false} />
      </mesh>
      {/* rotate handle: small grabbable knob off the front edge */}
      <group position={[0, 0.02, hd + 0.17]}>
        <mesh
          onPointerDown={onRotDown}
          onPointerMove={onRotMove}
          onPointerUp={onRotUp}
          onPointerCancel={onRotUp}
        >
          <sphereGeometry args={[0.055, 14, 14]} />
          <meshBasicMaterial color="#2563eb" />
        </mesh>
        <mesh raycast={() => null} position={[0, 0, -0.085]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[0.012, 0.17]} />
          <meshBasicMaterial color="#2563eb" transparent opacity={0.7} depthWrite={false} />
        </mesh>
      </group>
      {/* dims label - fixed screen size (distanceFactor breaks under the
          orthographic plan camera and blows the label up to fill the view) */}
      <Html position={[0, 0.05, -hd - 0.12]} center zIndexRange={[20, 0]}>
        <div
          style={{
            background: "rgba(15,23,42,0.85)",
            color: "#fff",
            padding: "3px 9px",
            borderRadius: 7,
            fontSize: 12,
            fontFamily: "system-ui, sans-serif",
            whiteSpace: "nowrap",
            pointerEvents: "none",
            letterSpacing: 0.2,
          }}
        >
          {label}
        </div>
      </Html>
    </group>
  );
}
