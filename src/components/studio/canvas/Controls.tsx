"use client";

// Room Studio - camera rigs for plan / orbit / walk modes.

import * as THREE from "three";
import { useEffect, useRef } from "react";
import { useThree, useFrame } from "@react-three/fiber";
import { OrbitControls, MapControls } from "@react-three/drei";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import type { DesignDoc } from "@/lib/studio/doc";
import { polygonBounds } from "@/lib/studio/geometry";
import { useStudio } from "../store";

const EYE_HEIGHT = 1.6;

export function Controls({ doc }: { doc: DesignDoc }) {
  const view = useStudio((s) => s.view);
  const dragging = useStudio((s) => s.dragging);
  const placing = useStudio((s) => s.placing);

  if (view === "plan") return <PlanRig doc={doc} enabled={!dragging} />;
  if (view === "walk") return <WalkRig doc={doc} />;
  return <OrbitRig doc={doc} enabled={!dragging && !placing} />;
}

function OrbitRig({ doc, enabled }: { doc: DesignDoc; enabled: boolean }) {
  const { camera, set, size } = useThree();
  const controlsRef = useRef<OrbitControlsImpl>(null);
  const saveCamera = useStudio((s) => s.saveCamera);
  const docEpoch = useStudio((s) => s.docEpoch);
  const initialized = useRef(false);

  // Swap to a perspective camera for this mode.
  useEffect(() => {
    const bounds = polygonBounds(doc.room.points);
    const cam = new THREE.PerspectiveCamera(50, size.width / size.height, 0.05, 120);
    const saved = useStudio.getState().doc.camera;
    if (saved && initialized.current) {
      cam.position.set(...saved.position);
    } else if (saved) {
      cam.position.set(...saved.position);
    } else {
      cam.position.set(
        bounds.center.x + bounds.width * 0.85,
        doc.room.height * 1.6,
        bounds.center.z + bounds.length * 1.15,
      );
    }
    set({ camera: cam });
    initialized.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docEpoch]);

  useEffect(() => {
    if (camera instanceof THREE.PerspectiveCamera) {
      camera.aspect = size.width / size.height;
      camera.updateProjectionMatrix();
    }
  }, [camera, size]);

  const bounds = polygonBounds(doc.room.points);
  const savedTarget = doc.camera?.target;

  return (
    <OrbitControls
      ref={controlsRef}
      enabled={enabled}
      makeDefault
      target={savedTarget ? new THREE.Vector3(...savedTarget) : new THREE.Vector3(bounds.center.x, doc.room.height * 0.35, bounds.center.z)}
      enableDamping
      dampingFactor={0.12}
      maxPolarAngle={Math.PI / 2 - 0.02}
      minDistance={0.8}
      maxDistance={28}
      onEnd={() => {
        const c = controlsRef.current;
        if (!c) return;
        saveCamera({
          position: [c.object.position.x, c.object.position.y, c.object.position.z],
          target: [c.target.x, c.target.y, c.target.z],
        });
      }}
    />
  );
}

function PlanRig({ doc, enabled }: { doc: DesignDoc; enabled: boolean }) {
  const { set, size } = useThree();

  useEffect(() => {
    const bounds = polygonBounds(doc.room.points);
    const margin = 1.6;
    const aspect = size.width / size.height;
    const spanX = (bounds.width + margin * 2) / 2;
    const spanZ = (bounds.length + margin * 2) / 2;
    const half = Math.max(spanX / aspect > spanZ ? spanX : spanZ * aspect, 2);
    const cam = new THREE.OrthographicCamera(-half, half, half / aspect, -half / aspect, 0.1, 100);
    cam.position.set(bounds.center.x, 30, bounds.center.z);
    cam.up.set(0, 0, -1);
    cam.lookAt(bounds.center.x, 0, bounds.center.z);
    set({ camera: cam });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.room.points, size.width, size.height]);

  return (
    <MapControls
      enabled={enabled}
      makeDefault
      enableRotate={false}
      screenSpacePanning
      zoomToCursor
      minZoom={0.4}
      maxZoom={8}
    />
  );
}

/** First-person walkthrough: drag to look, WASD/arrows to move, stays at eye height. */
function WalkRig({ doc }: { doc: DesignDoc }) {
  const { set, gl } = useThree();
  const yawPitch = useRef({ yaw: 0, pitch: 0 });
  const keys = useRef<Record<string, boolean>>({});
  const camRef = useRef<THREE.PerspectiveCamera | null>(null);

  useEffect(() => {
    const bounds = polygonBounds(doc.room.points);
    const cam = new THREE.PerspectiveCamera(68, gl.domElement.clientWidth / gl.domElement.clientHeight, 0.05, 80);
    // Spawn near the south edge looking north into the room.
    cam.position.set(bounds.center.x, EYE_HEIGHT, bounds.center.z + Math.max(0.5, bounds.length * 0.32));
    yawPitch.current = { yaw: 0, pitch: 0 };
    camRef.current = cam;
    set({ camera: cam });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const dom = gl.domElement;
    let looking = false;
    let lastX = 0;
    let lastY = 0;

    const down = (e: PointerEvent) => {
      looking = true;
      lastX = e.clientX;
      lastY = e.clientY;
      dom.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!looking) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      yawPitch.current.yaw -= dx * 0.0042;
      yawPitch.current.pitch = Math.max(-1.2, Math.min(1.2, yawPitch.current.pitch - dy * 0.0042));
    };
    const up = (e: PointerEvent) => {
      looking = false;
      try {
        dom.releasePointerCapture(e.pointerId);
      } catch {
        // released already
      }
    };
    const key = (down: boolean) => (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(k)) {
        keys.current[k] = down;
        e.preventDefault();
      }
    };
    const keyDown = key(true);
    const keyUp = key(false);

    dom.addEventListener("pointerdown", down);
    dom.addEventListener("pointermove", move);
    dom.addEventListener("pointerup", up);
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    return () => {
      dom.removeEventListener("pointerdown", down);
      dom.removeEventListener("pointermove", move);
      dom.removeEventListener("pointerup", up);
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
    };
  }, [gl]);

  useFrame((_, delta) => {
    const cam = camRef.current;
    if (!cam) return;
    const { yaw, pitch } = yawPitch.current;
    cam.rotation.set(0, 0, 0);
    cam.rotateY(yaw);
    cam.rotateX(pitch);

    const speed = 2.2 * delta;
    const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    const right = new THREE.Vector3(forward.z, 0, -forward.x);
    const k = keys.current;
    const move = new THREE.Vector3();
    if (k.w || k.arrowup) move.add(forward);
    if (k.s || k.arrowdown) move.sub(forward);
    if (k.d || k.arrowright) move.sub(right);
    if (k.a || k.arrowleft) move.add(right);
    if (move.lengthSq() > 0) {
      move.normalize().multiplyScalar(speed);
      cam.position.add(move);
      cam.position.y = EYE_HEIGHT;
    }
  });

  return null;
}
