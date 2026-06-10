"use client";

// Room Studio - plan-view room reshaping.
//
// Corner dots drag freely (angled walls come from here), wall dots drag the
// whole wall along its normal. Double-click a wall dot to split the wall into
// two (adds a corner); double-click a corner dot to remove it. Drags preview
// live and commit ONE undo step on release.

import * as THREE from "three";
import { useMemo, useRef } from "react";
import { Html } from "@react-three/drei";
import type { ThreeEvent } from "@react-three/fiber";
import type { DesignDoc, Pt } from "@/lib/studio/doc";
import { wallSegments, signedArea, polygonBounds } from "@/lib/studio/geometry";
import { inches, formatFtIn } from "@/lib/studio/units";
import { useStudio } from "../store";

const GRID = inches(1);
const MIN_EDGE = inches(12);
const MIN_AREA = 0.75; // m^2
// Handles float above every wall (max ceiling 16ft + slope headroom). Under
// the orthographic plan camera their screen position is unchanged, but they
// become the FIRST raycast hit - at floor level the wall slabs occlude them
// and swallow pointerdown.
const HANDLE_Y = 8;

type DragKind = { kind: "corner"; index: number } | { kind: "wall"; index: number };

interface RoomDrag {
  pointerId: number;
  target: DragKind;
  origRoom: DesignDoc["room"];
  points: Pt[];
  moved: boolean;
}

function validPolygon(points: Pt[]): boolean {
  if (Math.abs(signedArea(points)) < MIN_AREA) return false;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (Math.hypot(b.x - a.x, b.z - a.z) < MIN_EDGE) return false;
  }
  return true;
}

export function RoomEdit({ doc }: { doc: DesignDoc }) {
  const view = useStudio((s) => s.view);
  const presentMode = useStudio((s) => s.presentMode);
  const placing = useStudio((s) => s.placing);

  if (view !== "plan" || presentMode || placing) return null;
  return <RoomEditInner doc={doc} />;
}

function RoomEditInner({ doc }: { doc: DesignDoc }) {
  const points = doc.room.points;
  const walls = useMemo(() => wallSegments(points), [points]);
  const origSign = useMemo(() => Math.sign(signedArea(points)), [points]);
  const dragRef = useRef<RoomDrag | null>(null);

  const intersectFloor = (ray: THREE.Ray): Pt | null => {
    if (Math.abs(ray.direction.y) < 1e-6) return null;
    const t = -ray.origin.y / ray.direction.y;
    if (t < 0) return null;
    return { x: ray.origin.x + ray.direction.x * t, z: ray.origin.z + ray.direction.z * t };
  };

  const begin = (e: ThreeEvent<PointerEvent>, target: DragKind) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    try {
      (e.target as Element).setPointerCapture(e.pointerId);
    } catch {
      // synthetic events have no active pointer
    }
    dragRef.current = {
      pointerId: e.pointerId,
      target,
      origRoom: doc.room,
      points: points.map((p) => ({ ...p })),
      moved: false,
    };
  };

  const move = (e: ThreeEvent<PointerEvent>) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    const p = intersectFloor(e.ray);
    if (!p) return;

    const next = drag.points.map((q) => ({ ...q }));
    if (drag.target.kind === "corner") {
      next[drag.target.index] = {
        x: Math.round(p.x / GRID) * GRID,
        z: Math.round(p.z / GRID) * GRID,
      };
    } else {
      // translate the wall along its normal by the pointer's normal distance
      const w = wallSegments(drag.points)[drag.target.index];
      const mid = { x: (w.a.x + w.b.x) / 2, z: (w.a.z + w.b.z) / 2 };
      const dRaw = (p.x - mid.x) * w.normal.x + (p.z - mid.z) * w.normal.z;
      const d = Math.round(dRaw / GRID) * GRID;
      const i = drag.target.index;
      const j = (i + 1) % next.length;
      next[i] = { x: drag.points[i].x + w.normal.x * d, z: drag.points[i].z + w.normal.z * d };
      next[j] = { x: drag.points[j].x + w.normal.x * d, z: drag.points[j].z + w.normal.z * d };
    }

    if (Math.abs(signedArea(next)) < MIN_AREA || Math.sign(signedArea(next)) !== origSign) return;
    let minEdge = Infinity;
    for (let i = 0; i < next.length; i++) {
      const a = next[i];
      const b = next[(i + 1) % next.length];
      minEdge = Math.min(minEdge, Math.hypot(b.x - a.x, b.z - a.z));
    }
    if (minEdge < MIN_EDGE) return;

    if (!drag.moved) {
      drag.moved = true;
      useStudio.getState().setDragging(true);
    }
    useStudio.getState().previewRoomShape({ ...drag.origRoom, points: next });
  };

  const end = (e: ThreeEvent<PointerEvent>) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    dragRef.current = null;
    try {
      (e.target as Element).releasePointerCapture(e.pointerId);
    } catch {
      // already released
    }
    if (!drag.moved) return;
    useStudio.getState().setDragging(false);
    const s = useStudio.getState();
    const finalRoom = s.doc.room;
    // restore the original silently, then commit the final shape as ONE undo step
    s.previewRoomShape(drag.origRoom);
    s.setRoomShape(finalRoom);
  };

  const splitWall = (index: number) => {
    const w = walls[index];
    const mid = { x: (w.a.x + w.b.x) / 2, z: (w.a.z + w.b.z) / 2 };
    const next = [...points.slice(0, index + 1), mid, ...points.slice(index + 1)];
    useStudio.getState().setRoomShape({ ...doc.room, points: next, slope: undefined });
  };

  const removeCorner = (index: number) => {
    if (points.length <= 3) return;
    const next = points.filter((_, i) => i !== index);
    if (!validPolygon(next)) return;
    useStudio.getState().setRoomShape({ ...doc.room, points: next, slope: points.length - 1 === 4 ? doc.room.slope : undefined });
  };

  const bounds = polygonBounds(points);
  const dragging = useStudio((s) => s.dragging);

  return (
    <group>
      {/* corner handles */}
      {points.map((p, i) => (
        <group key={`c${i}`} position={[p.x, HANDLE_Y, p.z]}>
          <mesh raycast={() => null}>
            <cylinderGeometry args={[0.085, 0.085, 0.02, 20]} />
            <meshBasicMaterial color="#2563eb" depthTest={false} />
          </mesh>
          {/* generous hit zone - transparent, not invisible (raycaster skips invisible) */}
          <mesh
            onPointerDown={(e) => begin(e, { kind: "corner", index: i })}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
            onDoubleClick={(e) => {
              e.stopPropagation();
              removeCorner(i);
            }}
          >
            <cylinderGeometry args={[0.22, 0.22, 0.04, 12]} />
            <meshBasicMaterial transparent opacity={0} depthWrite={false} depthTest={false} />
          </mesh>
        </group>
      ))}
      {/* wall mid handles */}
      {walls.map((w) => (
        <group
          key={`w${w.index}`}
          position={[(w.a.x + w.b.x) / 2, HANDLE_Y, (w.a.z + w.b.z) / 2]}
          rotation={[0, -Math.atan2(w.b.z - w.a.z, w.b.x - w.a.x), 0]}
        >
          <mesh raycast={() => null}>
            <boxGeometry args={[0.26, 0.02, 0.08]} />
            <meshBasicMaterial color="#60a5fa" depthTest={false} />
          </mesh>
          <mesh
            onPointerDown={(e) => begin(e, { kind: "wall", index: w.index })}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
            onDoubleClick={(e) => {
              e.stopPropagation();
              splitWall(w.index);
            }}
          >
            <boxGeometry args={[0.5, 0.04, 0.3]} />
            <meshBasicMaterial transparent opacity={0} depthWrite={false} depthTest={false} />
          </mesh>
        </group>
      ))}
      {/* live dimensions while reshaping */}
      {dragging && (
        <Html position={[bounds.center.x, 0.1, bounds.min.z - 0.45]} center zIndexRange={[30, 0]}>
          <div
            style={{
              background: "rgba(15,23,42,0.85)",
              color: "#fff",
              padding: "3px 10px",
              borderRadius: 7,
              fontSize: 12,
              fontFamily: "system-ui, sans-serif",
              whiteSpace: "nowrap",
              pointerEvents: "none",
            }}
          >
            {formatFtIn(bounds.width)} x {formatFtIn(bounds.length)}
          </div>
        </Html>
      )}
    </group>
  );
}
