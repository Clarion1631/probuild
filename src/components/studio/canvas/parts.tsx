"use client";

// Room Studio - shared materials + tiny primitive helpers for builders.
//
// Materials are cached per finish id and SHARED across every mesh that uses
// them - one program, minimal state changes. Selection effects never mutate
// these (highlights are separate meshes), so sharing is safe.

import * as THREE from "three";
import { getFinish } from "@/lib/studio/materials";

const matCache = new Map<string, THREE.MeshStandardMaterial>();

export function mat(finishId: string | undefined, fallback = "cab-white"): THREE.MeshStandardMaterial {
  const f = getFinish(finishId, fallback);
  let m = matCache.get(f.id);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color: f.hex,
      roughness: f.roughness ?? 0.85,
      metalness: f.metalness ?? 0,
    });
    matCache.set(f.id, m);
  }
  return m;
}

/** Darkened variant of a finish (door gaps, recesses, kick plates). */
export function matShade(finishId: string | undefined, amount: number, fallback = "cab-white"): THREE.MeshStandardMaterial {
  const f = getFinish(finishId, fallback);
  const key = `${f.id}|shade${amount}`;
  let m = matCache.get(key);
  if (!m) {
    const c = new THREE.Color(f.hex);
    c.multiplyScalar(1 - amount);
    m = new THREE.MeshStandardMaterial({
      color: c,
      roughness: Math.min(1, (f.roughness ?? 0.85) + 0.05),
      metalness: f.metalness ?? 0,
    });
    matCache.set(key, m);
  }
  return m;
}

const fixedCache = new Map<string, THREE.Material>();

/** One-off fixed materials (glass, emissive bulbs, soil...). */
export function fixedMat(key: string, make: () => THREE.Material): THREE.Material {
  let m = fixedCache.get(key);
  if (!m) {
    m = make();
    fixedCache.set(key, m);
  }
  return m;
}

export const glassMat = () =>
  fixedMat("glass", () => new THREE.MeshStandardMaterial({
    color: "#cfe0e6",
    roughness: 0.08,
    metalness: 0.1,
    transparent: true,
    opacity: 0.22,
    side: THREE.DoubleSide,
  }));

export const mirrorMat = () =>
  fixedMat("mirror", () => new THREE.MeshStandardMaterial({
    color: "#cdd6dc",
    roughness: 0.03,
    metalness: 0.9,
  }));

export const bulbMat = (on: boolean) =>
  fixedMat(on ? "bulb-on" : "bulb-off", () => new THREE.MeshStandardMaterial({
    color: on ? "#fff7e0" : "#d8d4c8",
    emissive: on ? "#ffe9b0" : "#000000",
    emissiveIntensity: on ? 1.6 : 0,
    roughness: 0.4,
  }));

export const blackGlassMat = () =>
  fixedMat("black-glass", () => new THREE.MeshStandardMaterial({
    color: "#101418",
    roughness: 0.12,
    metalness: 0.4,
  }));

export const ceramicMat = () =>
  fixedMat("ceramic", () => new THREE.MeshStandardMaterial({
    color: "#f2f1ec",
    roughness: 0.18,
  }));

export const soilMat = () =>
  fixedMat("soil", () => new THREE.MeshStandardMaterial({ color: "#3a2f26", roughness: 1 }));

export const leafMat = () =>
  fixedMat("leaf", () => new THREE.MeshStandardMaterial({ color: "#4d6b45", roughness: 0.9 }));

export const leafMat2 = () =>
  fixedMat("leaf2", () => new THREE.MeshStandardMaterial({ color: "#5d7d52", roughness: 0.9 }));

export const screenMat = () =>
  fixedMat("screen", () => new THREE.MeshStandardMaterial({
    color: "#0a0c10",
    roughness: 0.25,
    metalness: 0.2,
  }));

export const flameMat = () =>
  fixedMat("flame", () => new THREE.MeshStandardMaterial({
    color: "#ff9a3c",
    emissive: "#ff7a18",
    emissiveIntensity: 1.4,
    roughness: 0.8,
  }));

// ------------------------------ Primitives ------------------------------
// Thin wrappers keep builder code dense and readable. All sizes full extents.

export interface BoxProps {
  s: [number, number, number];
  p?: [number, number, number];
  r?: [number, number, number];
  m: THREE.Material;
  castShadow?: boolean;
  receiveShadow?: boolean;
}

export function Box({ s, p = [0, 0, 0], r, m, castShadow = true, receiveShadow = true }: BoxProps) {
  return (
    <mesh position={p} rotation={r} material={m} castShadow={castShadow} receiveShadow={receiveShadow}>
      <boxGeometry args={s} />
    </mesh>
  );
}

export function Cyl({
  rTop, rBot, h, p = [0, 0, 0], m, seg = 20, castShadow = true, open = false, rot,
}: {
  rTop: number; rBot: number; h: number; p?: [number, number, number];
  m: THREE.Material; seg?: number; castShadow?: boolean; open?: boolean; r?: [number, number, number];
  rot?: [number, number, number];
}) {
  return (
    <mesh position={p} rotation={rot} material={m} castShadow={castShadow} receiveShadow>
      <cylinderGeometry args={[rTop, rBot, h, seg, 1, open]} />
    </mesh>
  );
}

export function Ball({ r, p = [0, 0, 0], m, seg = 18, half = false }: {
  r: number; p?: [number, number, number]; m: THREE.Material; seg?: number; half?: boolean;
}) {
  return (
    <mesh position={p} material={m} castShadow receiveShadow>
      <sphereGeometry args={half ? [r, seg, Math.ceil(seg / 2), 0, Math.PI * 2, 0, Math.PI / 2] : [r, seg, seg]} />
    </mesh>
  );
}

/**
 * Shaker-style front: outer slab + recessed center panel. `w`,`h` full size,
 * `t` thickness; renders facing +Z with its back at z=0.
 */
export function ShakerFront({ w, h, t, finish, p = [0, 0, 0] }: {
  w: number; h: number; t: number; finish: string | undefined; p?: [number, number, number];
}) {
  const rail = Math.min(0.07, w * 0.18, h * 0.18);
  const innerW = Math.max(0.01, w - rail * 2);
  const innerH = Math.max(0.01, h - rail * 2);
  return (
    <group position={p}>
      {/* outer slab */}
      <Box s={[w, h, t * 0.6]} p={[0, 0, t * 0.3]} m={mat(finish)} />
      {/* recessed panel - slightly darker for depth */}
      <Box s={[innerW, innerH, t * 0.5]} p={[0, 0, t * 0.45]} m={matShade(finish, 0.12)} castShadow={false} />
      {/* face frame highlight: thin border on top of slab */}
      <Box s={[w, rail, t]} p={[0, h / 2 - rail / 2, t * 0.5]} m={mat(finish)} castShadow={false} />
      <Box s={[w, rail, t]} p={[0, -h / 2 + rail / 2, t * 0.5]} m={mat(finish)} castShadow={false} />
      <Box s={[rail, h, t]} p={[-w / 2 + rail / 2, 0, t * 0.5]} m={mat(finish)} castShadow={false} />
      <Box s={[rail, h, t]} p={[w / 2 - rail / 2, 0, t * 0.5]} m={mat(finish)} castShadow={false} />
    </group>
  );
}

/** Bar pull hardware, horizontal or vertical. */
export function BarPull({ len, finish, p, vertical = false }: {
  len: number; finish: string | undefined; p: [number, number, number]; vertical?: boolean;
}) {
  return (
    <group position={p} rotation={vertical ? [0, 0, Math.PI / 2] : undefined}>
      <Cyl rTop={0.006} rBot={0.006} h={len} rot={[0, 0, Math.PI / 2]} m={mat(finish, "metal-brushed-nickel")} seg={8} castShadow={false} />
    </group>
  );
}

/** Round knob. */
export function Knob({ finish, p }: { finish: string | undefined; p: [number, number, number] }) {
  return <Ball r={0.012} p={p} m={mat(finish, "metal-brushed-nickel")} seg={10} />;
}
