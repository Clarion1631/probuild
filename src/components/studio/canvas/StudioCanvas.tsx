"use client";

// Room Studio - R3F canvas root. Deliberately minimal: one shadow-casting sun,
// hemisphere fill, no post-processing, no HDRI downloads. Smoothness > frills.

import * as THREE from "three";
import { Canvas, useThree, useFrame } from "@react-three/fiber";
import { ContactShadows, Environment, Grid, Lightformer } from "@react-three/drei";
import { useEffect, useMemo } from "react";
import type { DesignDoc } from "@/lib/studio/doc";
import { polygonBounds, wallSegments } from "@/lib/studio/geometry";
import { useStudio } from "../store";
import { Room } from "./Room";
import { Items } from "./Items";
import { Placement } from "./Placement";
import { Controls } from "./Controls";
import { RoomEdit } from "./RoomEdit";

/** Exposes the GL trio for snapshot capture without re-rendering React. */
export interface CanvasHandles {
  gl: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.Camera;
  /** Manually advance one frame - lets tooling render while the tab is hidden (rAF paused). */
  advance: () => void;
}

let liveHandles: CanvasHandles | null = null;
export function getCanvasHandles(): CanvasHandles | null {
  return liveHandles;
}

/**
 * Dollhouse view: in 3D orbit, walls between the camera and the room interior
 * are hidden - along with any doors/windows mounted in them. Every object
 * tagged with userData.wallIndex (wall slabs in Room, door/window groups in
 * Items) is toggled in one pass per frame.
 */
function DollhouseSync({ doc }: { doc: DesignDoc }) {
  const view = useStudio((s) => s.view);
  const scene = useThree((s) => s.scene);
  const walls = useMemo(() => wallSegments(doc.room.points), [doc.room.points]);

  useFrame(({ camera }) => {
    const hideMode = view === "orbit";
    const hidden: boolean[] = walls.map((w) => {
      if (!hideMode) return false;
      const mx = (w.a.x + w.b.x) / 2;
      const mz = (w.a.z + w.b.z) / 2;
      const vx = camera.position.x - mx;
      const vz = camera.position.z - mz;
      return vx * w.normal.x + vz * w.normal.z <= -0.1;
    });
    scene.traverse((o) => {
      const idx = o.userData?.wallIndex as number | undefined;
      if (idx === undefined) return;
      o.visible = !hidden[idx];
    });
  });

  return null;
}

function HandleBridge() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const advance = useThree((s) => s.advance);
  useEffect(() => {
    liveHandles = { gl, scene, camera, advance: () => advance(performance.now() / 1000, true) };
    if (process.env.NODE_ENV === "development") {
      (window as unknown as { __studio?: CanvasHandles }).__studio = liveHandles;
    }
    return () => {
      liveHandles = null;
    };
  }, [gl, scene, camera, advance]);
  return null;
}

/**
 * R3F only initializes once react-use-measure reports a nonzero size, and that
 * measurement comes from a ResizeObserver - which Chrome never services in
 * hidden/background tabs. If the canvas opens in a background tab, init stalls
 * forever. A synthetic window resize makes react-use-measure fall back to a
 * synchronous getBoundingClientRect, unsticking it. No-op when already live.
 */
function useResizeKick() {
  useEffect(() => {
    const t = setTimeout(() => {
      if (!liveHandles) window.dispatchEvent(new Event("resize"));
    }, 400);
    const t2 = setTimeout(() => {
      if (!liveHandles) window.dispatchEvent(new Event("resize"));
    }, 1500);
    return () => {
      clearTimeout(t);
      clearTimeout(t2);
    };
  }, []);
}

export function StudioCanvas() {
  const doc = useStudio((s) => s.doc);
  const lightsOn = useStudio((s) => s.lightsOn);
  const view = useStudio((s) => s.view);
  const select = useStudio((s) => s.select);
  const setActiveSurface = useStudio((s) => s.setActiveSurface);
  useResizeKick();

  const bounds = useMemo(() => polygonBounds(doc.room.points), [doc.room.points]);
  const sunTarget = useMemo(() => {
    const t = new THREE.Object3D();
    t.position.set(bounds.center.x, 0, bounds.center.z);
    return t;
  }, [bounds.center.x, bounds.center.z]);

  const shadowSpan = Math.max(bounds.width, bounds.length) * 0.9 + 2;

  return (
    <Canvas
      className="touch-none"
      shadows={{ type: THREE.PCFSoftShadowMap }}
      dpr={[1, 1.75]}
      resize={{ scroll: false, debounce: 0 }}
      gl={{
        antialias: true,
        toneMapping: THREE.ACESFilmicToneMapping,
        toneMappingExposure: 1.12,
        preserveDrawingBuffer: true,
      }}
      onCreated={(state) => {
        // Generated env map provides reflections; keep its diffuse contribution
        // low so the directional/hemisphere rig stays in charge of brightness.
        state.scene.environmentIntensity = 0.55;
      }}
      onPointerMissed={() => {
        select(null);
        setActiveSurface(null);
      }}
    >
      <HandleBridge />
      <Controls doc={doc} />

      {/* scene background lives in GL (not CSS) so snapshots include it */}
      <color attach="background" args={["#e7ebf0"]} />

      {/* Locally-generated environment map (no downloads) - gives metals,
          counters, and glass something to reflect. Rendered once. */}
      <Environment resolution={64} frames={1}>
        <Lightformer form="rect" intensity={2.2} position={[0, 4, -9]} scale={[12, 6, 1]} color="#e8eff6" />
        <Lightformer form="rect" intensity={1.4} position={[-8, 3, 2]} rotation-y={Math.PI / 2} scale={[9, 4, 1]} color="#ffffff" />
        <Lightformer form="rect" intensity={1.7} position={[8, 4, 1]} rotation-y={-Math.PI / 2} scale={[9, 5, 1]} color="#fdf2e3" />
        <Lightformer form="ring" intensity={1.6} position={[0, 8, 0]} rotation-x={Math.PI / 2} scale={5} color="#ffffff" />
        <Lightformer form="rect" intensity={0.6} position={[0, -4, 0]} rotation-x={Math.PI / 2} scale={[10, 10, 1]} color="#b9b2a6" />
      </Environment>

      {/* daylight rig */}
      <hemisphereLight args={["#e6edf5", "#c2baae", 1.05]} />
      <ambientLight intensity={0.5} />
      <directionalLight
        position={[bounds.center.x + 6, 9, bounds.center.z + 4]}
        intensity={lightsOn ? 1.5 : 1.9}
        color="#fff4e4"
        castShadow={view !== "plan"}
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
        shadow-radius={6}
        shadow-camera-left={-shadowSpan}
        shadow-camera-right={shadowSpan}
        shadow-camera-top={shadowSpan}
        shadow-camera-bottom={-shadowSpan}
        shadow-camera-near={1}
        shadow-camera-far={30}
        target={sunTarget}
      />
      <primitive object={sunTarget} />
      {/* soft fill bounce from the opposite side, no shadows */}
      <directionalLight
        position={[bounds.center.x - 5, 6, bounds.center.z - 6]}
        intensity={0.5}
        color="#e8ecf4"
      />

      {/* measuring grid - plan view only: 1 ft cells, 4 ft sections */}
      {view === "plan" && (
        <Grid
          position={[0, 0.006, 0]}
          cellSize={0.3048}
          cellThickness={0.55}
          cellColor="#b6c2cf"
          sectionSize={1.2192}
          sectionThickness={1}
          sectionColor="#8da2b5"
          fadeDistance={70}
          fadeStrength={0}
          infiniteGrid
          raycast={() => null}
        />
      )}

      <Room doc={doc} />
      <Items doc={doc} />
      <Placement doc={doc} />
      <RoomEdit doc={doc} />
      <DollhouseSync doc={doc} />

      {/* grounding shadow outside the room footprint (plan/orbit polish) */}
      {view !== "walk" && (
        <ContactShadows
          position={[bounds.center.x, -0.005, bounds.center.z]}
          scale={Math.max(bounds.width, bounds.length) + 4}
          blur={2.4}
          far={2}
          opacity={0.32}
          resolution={512}
          frames={1}
        />
      )}
    </Canvas>
  );
}
