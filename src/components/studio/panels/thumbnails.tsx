"use client";

// Room Studio - catalog thumbnails.
//
// A single hidden R3F root renders each catalog item once (the same
// procedural builders the canvas uses) and caches the result as a PNG data
// URL. Requests are serialized through a queue; frames are driven manually
// with advance() so this works even in hidden/background tabs.

import * as THREE from "three";
import { useEffect, useState } from "react";
import { createRoot, useThree } from "@react-three/fiber";
import type { CatalogItem } from "@/lib/studio/catalog";
import { BUILDERS } from "../canvas/builders";

const SIZE = 160;

const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();

interface ThumbRoot {
  root: ReturnType<typeof createRoot>;
  canvas: HTMLCanvasElement;
}

let thumbRootPromise: Promise<ThumbRoot | null> | null = null;
let queue: Promise<unknown> = Promise.resolve();

function ensureRoot(): Promise<ThumbRoot | null> {
  if (thumbRootPromise) return thumbRootPromise;
  if (typeof document === "undefined") return Promise.resolve(null);
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const root = createRoot(canvas);
  thumbRootPromise = root
    .configure({
      frameloop: "never",
      dpr: 1,
      size: { width: SIZE, height: SIZE, top: 0, left: 0 },
      gl: { alpha: true, antialias: true, preserveDrawingBuffer: true },
      camera: { fov: 32, near: 0.01, far: 30, position: [2, 1.6, 2.6] },
      onCreated: (state) => {
        state.gl.setClearColor(0x000000, 0);
        state.gl.toneMapping = THREE.ACESFilmicToneMapping;
      },
    })
    .then(() => ({ root, canvas }))
    .catch(() => null);
  return thumbRootPromise;
}

function ThumbScene({ def }: { def: CatalogItem }) {
  const Builder = BUILDERS[def.mesh];
  if (!Builder) return null;
  const span = Math.max(def.w, def.h, def.d);
  const dist = span * 1.35 + 0.25;
  const dir = new THREE.Vector3(1, 0.62, 1.25).normalize();
  const pos = dir.multiplyScalar(dist);
  const target = new THREE.Vector3(0, def.h / 2, 0);
  return (
    <>
      <PerCamera position={pos} target={target} />
      <hemisphereLight args={["#eef2f7", "#cfc8bb", 1.15]} />
      <directionalLight position={[3, 5, 4]} intensity={1.6} color="#fff4e4" />
      <directionalLight position={[-4, 3, -3]} intensity={0.7} color="#e8ecf4" />
      <group>
        <Builder w={def.w} d={def.d} h={def.h} finishes={def.finishes ?? {}} lightsOn />
      </group>
    </>
  );
}

function PerCamera({ position, target }: { position: THREE.Vector3; target: THREE.Vector3 }) {
  const camera = useThree((s) => s.camera);
  useEffect(() => {
    camera.position.copy(position);
    camera.lookAt(target);
    camera.updateProjectionMatrix();
  }, [camera, position, target]);
  return null;
}

export function getItemThumbnail(def: CatalogItem): Promise<string | null> {
  const cached = cache.get(def.id);
  if (cached) return Promise.resolve(cached);
  const pending = inflight.get(def.id);
  if (pending) return pending;

  const task = (queue = queue.then(async () => {
    const again = cache.get(def.id);
    if (again) return again;
    const tr = await ensureRoot();
    if (!tr) return null;
    try {
      const store = tr.root.render(<ThumbScene def={def} />);
      // let the reconciler commit + camera effect run, then draw two frames
      await new Promise((r) => setTimeout(r, 0));
      const state = store.getState();
      state.advance(performance.now() / 1000, true);
      await new Promise((r) => setTimeout(r, 0));
      state.advance(performance.now() / 1000 + 0.016, true);
      const url = tr.canvas.toDataURL("image/png");
      cache.set(def.id, url);
      return url;
    } catch {
      return null;
    }
  })) as Promise<string | null>;

  inflight.set(def.id, task);
  task.finally(() => inflight.delete(def.id));
  return task;
}

/** Returns the cached/generated thumbnail data URL for a catalog item. */
export function useItemThumbnail(def: CatalogItem): string | null {
  // Cards are keyed by item id, so a def change remounts and re-runs the
  // lazy initializer; the effect only handles the not-yet-generated case.
  const [url, setUrl] = useState<string | null>(() => cache.get(def.id) ?? null);
  useEffect(() => {
    if (url) return;
    let alive = true;
    getItemThumbnail(def).then((u) => {
      if (alive && u) setUrl(u);
    });
    return () => {
      alive = false;
    };
  }, [def, url]);
  return url;
}
