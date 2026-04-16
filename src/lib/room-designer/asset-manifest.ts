// Client-side manifest loader for Room Designer assets.
//
// Fetches the Supabase Storage manifest.json once per session and caches it
// in module scope. Provides synchronous accessors (null-safe when the fetch
// is still in flight or has failed) plus a React hook that subscribes to
// "manifest ready" so that consumers re-render after the fetch resolves.
//
// Failure mode: if the Supabase fetch fails, the manifest map stays empty
// and every getModelUrl returns null — AssetNode then falls back to its
// box-geometry renderer and the app stays fully usable.

"use client";

import { useEffect, useState } from "react";
import { useGLTF } from "@react-three/drei";

export type ManifestEntry = {
    id: string;
    kind: "model" | "texture";
    url: string;
    thumbnailUrl: string;
    license: "CC0" | "CC-BY" | "MIT";
    source: string; // e.g. "quaternius:Kitchen_Fridge.glb" or "...glb (proxy)"
    uploadedAt: string; // ISO 8601
};

type Manifest = { generatedAt: string; entries: ManifestEntry[] };

const SUPABASE_URL =
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://ghzdbzdnwjxazvmcefbh.supabase.co";
const MANIFEST_URL = `${SUPABASE_URL}/storage/v1/object/public/room-designer-assets/manifest.json`;

// Warm up the three.js GLTF cache for the 10 most common assets once the
// manifest URL is known. All 10 ids verified present in asset-registry.ts.
const PRELOAD_IDS = [
    "base-cabinet-24",
    "base-cabinet-36",
    "wall-cabinet-30",
    "refrigerator-french",
    "stove-range-30",
    "kitchen-sink-farmhouse",
    "toilet-standard",
    "bathtub-freestanding",
    "door-single",
    "window-single-hung",
];

let manifestMap: Map<string, ManifestEntry> | null = null;
let manifestPromise: Promise<Map<string, ManifestEntry>> | null = null;
const listeners = new Set<() => void>();

function getModelUrlFromMap(
    map: Map<string, ManifestEntry>,
    assetId: string,
): string | null {
    const e = map.get(assetId);
    return e && e.kind === "model" ? e.url : null;
}

export function loadManifest(): Promise<Map<string, ManifestEntry>> {
    if (manifestPromise) return manifestPromise;
    // cache: "default" — let Supabase CDN + browser cache headers drive
    // freshness. "force-cache" would pin to the browser cache and miss
    // re-uploaded assets; Next.js `next: {}` options don't apply in a
    // "use client" module (server-only).
    manifestPromise = fetch(MANIFEST_URL, { cache: "default" })
        .then((r) => {
            if (!r.ok) throw new Error(`Manifest fetch failed: ${r.status}`);
            return r.json() as Promise<Manifest>;
        })
        .then((m) => {
            const map = new Map<string, ManifestEntry>();
            for (const e of m.entries) map.set(e.id, e);
            manifestMap = map;
            for (const id of PRELOAD_IDS) {
                const url = getModelUrlFromMap(map, id);
                if (url) useGLTF.preload(url);
            }
            listeners.forEach((l) => l());
            return map;
        })
        .catch((err) => {
            // Permanent for the session — no retry. Graceful fallback:
            // every AssetNode renders its box because getModelUrl returns
            // null for an empty map. Leaving `manifestPromise` set (to the
            // already-resolved-with-empty-map promise) prevents retry
            // storms on repeated AssetCard mounts after a network blip.
            console.warn("[room-designer] manifest load failed, using box fallback", err);
            manifestMap = new Map();
            listeners.forEach((l) => l());
            return manifestMap;
        });
    return manifestPromise;
}

export function getManifestEntry(assetId: string): ManifestEntry | null {
    return manifestMap?.get(assetId) ?? null;
}

export function getModelUrl(assetId: string): string | null {
    const e = getManifestEntry(assetId);
    return e && e.kind === "model" ? e.url : null;
}

export function isProxyAsset(assetId: string): boolean {
    return !!getManifestEntry(assetId)?.source.includes("(proxy)");
}

// React hook — subscribes the caller to "manifest loaded" so that any
// synchronous consumer (getModelUrl, isProxyAsset) re-runs after fetch.
export function useManifestReady(): boolean {
    const [ready, setReady] = useState(manifestMap !== null);
    useEffect(() => {
        if (manifestMap !== null) {
            setReady(true);
            return;
        }
        const l = () => setReady(true);
        listeners.add(l);
        loadManifest(); // idempotent
        return () => {
            listeners.delete(l);
        };
    }, []);
    return ready;
}
