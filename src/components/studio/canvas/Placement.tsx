"use client";

// Room Studio - click-to-place flow. While `placing` is set, a ghost of the
// real item follows the cursor (with the same snapping as drag); click drops
// it, Esc / right-click cancels.

import * as THREE from "three";
import { useMemo, useRef, useEffect, useState, useCallback } from "react";
import type { ThreeEvent } from "@react-three/fiber";
import type { DesignDoc } from "@/lib/studio/doc";
import type { CatalogItem } from "@/lib/studio/catalog";
import {
  wallSegments, nearestWall, wallFacingRotation, pointInPolygon, snapToNeighbors, type OBB,
} from "@/lib/studio/geometry";
import { inches } from "@/lib/studio/units";
import { useStudio } from "../store";
import { BUILDERS } from "./builders";
import { resolveItem } from "./Items";

const GRID = inches(1);

export function Placement({ doc }: { doc: DesignDoc }) {
  const placing = useStudio((s) => s.placing);
  if (!placing) return null;
  // Keyed by item id: pose state resets naturally when the armed item changes.
  return <PlacementInner key={placing.id} doc={doc} placing={placing} />;
}

function PlacementInner({ doc, placing }: { doc: DesignDoc; placing: CatalogItem }) {
  const setPlacing = useStudio((s) => s.setPlacing);
  const addItem = useStudio((s) => s.addItem);
  const lightsOn = useStudio((s) => s.lightsOn);

  const walls = useMemo(() => wallSegments(doc.room.points), [doc.room.points]);
  const [pose, setPose] = useState<{ x: number; z: number; rotation: number } | null>(null);
  const poseRef = useRef(pose);
  useEffect(() => {
    poseRef.current = pose;
  }, [pose]);

  const obbOthers = useMemo<OBB[]>(() => {
    return doc.items
      .map((o) => {
        const ro = resolveItem(o);
        if (!ro || ro.def.mount !== placing.mount) return null;
        return { cx: o.x, cz: o.z, hw: ro.w / 2, hd: ro.d / 2, rot: o.rotation } as OBB;
      })
      .filter(Boolean) as OBB[];
  }, [doc.items, placing]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPlacing(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setPlacing]);

  const computePose = useCallback((pt: { x: number; z: number }) => {
    let x = pt.x;
    let z = pt.z;
    let rotation = poseRef.current?.rotation ?? 0;

    if (placing.mount === "wall") {
      const hit = nearestWall({ x, z }, walls);
      if (hit) {
        rotation = wallFacingRotation(hit.wall);
        const off = placing.category === "doors-windows" ? 0 : placing.d / 2;
        const halfFrac = (placing.w / 2) / hit.wall.length;
        const t = Math.min(1 - halfFrac, Math.max(halfFrac, hit.t));
        x = hit.wall.a.x + hit.wall.dir.x * hit.wall.length * t + hit.wall.normal.x * off;
        z = hit.wall.a.z + hit.wall.dir.z * hit.wall.length * t + hit.wall.normal.z * off;
        return { x, z, rotation };
      }
    }

    x = Math.round(x / GRID) * GRID;
    z = Math.round(z / GRID) * GRID;

    if (placing.wallSnap && placing.mount === "floor") {
      const hit = nearestWall({ x, z }, walls);
      if (hit && hit.distance < placing.d / 2 + 0.4) {
        rotation = wallFacingRotation(hit.wall);
        const halfFrac = (placing.w / 2) / hit.wall.length;
        const t = Math.min(1 - halfFrac, Math.max(halfFrac, hit.t));
        x = hit.wall.a.x + hit.wall.dir.x * hit.wall.length * t + hit.wall.normal.x * (placing.d / 2);
        z = hit.wall.a.z + hit.wall.dir.z * hit.wall.length * t + hit.wall.normal.z * (placing.d / 2);
      }
    }

    if (placing.category === "cabinets" || placing.category === "appliances") {
      const snapped = snapToNeighbors(
        { cx: x, cz: z, hw: placing.w / 2, hd: placing.d / 2, rot: rotation },
        obbOthers,
        inches(5),
      );
      if (snapped) {
        x = snapped.cx;
        z = snapped.cz;
      }
    }

    if (!pointInPolygon({ x, z }, doc.room.points)) return poseRef.current;
    return { x, z, rotation };
  }, [placing, walls, obbOthers, doc.room.points]);

  const Builder = BUILDERS[placing.mesh];
  const baseY = placing.mount === "ceiling"
    ? doc.room.height - placing.h
    : placing.elevation ?? 0;

  const onMove = (e: ThreeEvent<PointerEvent>) => {
    const next = computePose({ x: e.point.x, z: e.point.z });
    if (next) setPose(next);
  };

  const onClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    const p = poseRef.current;
    if (!p) return;
    addItem(placing.id, {
      x: p.x,
      z: p.z,
      rotation: p.rotation,
      y: placing.mount === "wall" && placing.elevation ? placing.elevation : undefined,
    });
    // Hold Shift to keep placing more of the same item.
    if (!e.shiftKey) setPlacing(null);
  };

  return (
    <group>
      {/* capture plane spanning the whole scene at floor level */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.001, 0]}
        onPointerMove={onMove}
        onClick={onClick}
        onContextMenu={(e) => {
          e.stopPropagation();
          setPlacing(null);
        }}
      >
        <planeGeometry args={[80, 80]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>

      {pose && Builder && (
        <group position={[pose.x, baseY, pose.z]} rotation={[0, pose.rotation, 0]}>
          <Builder w={placing.w} d={placing.d} h={placing.h} finishes={placing.finishes ?? {}} lightsOn={lightsOn} />
          {/* footprint ring so the drop target is obvious */}
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, placing.mount === "wall" || placing.mount === "ceiling" ? -baseY + 0.012 : 0.012, 0]} raycast={() => null}>
            <ringGeometry args={[Math.max(placing.w, placing.d) / 2 + 0.04, Math.max(placing.w, placing.d) / 2 + 0.1, 36]} />
            <meshBasicMaterial color="#2563eb" transparent opacity={0.65} depthWrite={false} side={THREE.DoubleSide} />
          </mesh>
        </group>
      )}
    </group>
  );
}
