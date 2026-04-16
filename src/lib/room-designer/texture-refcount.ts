// Reference-counted texture disposal.
//
// Why this exists:
//   drei's `useTexture` keeps an internal cache keyed by URL — multiple meshes
//   pointing at the same texture URL receive the SAME `THREE.Texture` object.
//   Calling `texture.dispose()` on unmount naïvely would break every sibling
//   still pointing at that texture.
//
//   This module wraps the dispose step in a refcount: `acquire(url, tex)` on
//   mount, `release(url)` on unmount. When the count hits zero, we dispose
//   the texture AND drop it from our local cache — but we never touch drei's
//   internal cache, so its next `useTexture(url)` will refetch if needed.
//
// Callers: SurfaceMaterial's PBRMaterial acquires all 5 maps in a useEffect
// and releases them in the cleanup. This keeps GPU memory bounded as users
// swap materials across many surfaces without requiring a full scene unmount.

import type * as THREE from "three";

const counts = new Map<string, number>();
const cache = new Map<string, THREE.Texture>();

/** Bump the refcount for `url`. Pass the live texture so we can dispose it
 *  later even if the drei cache has moved on. */
export function acquire(url: string, tex: THREE.Texture): void {
    cache.set(url, tex);
    counts.set(url, (counts.get(url) ?? 0) + 1);
}

/** Drop the refcount for `url`. When it reaches zero the texture is disposed
 *  and removed from our local cache. Safe to call with an unknown URL (no-op). */
export function release(url: string): void {
    const cur = counts.get(url);
    if (!cur) return; // no-op — unknown url or already at 0
    const next = cur - 1;
    if (next <= 0) {
        cache.get(url)?.dispose();
        cache.delete(url);
        counts.delete(url);
    } else {
        counts.set(url, next);
    }
}

/** Test-only helper so specs can assert disposal without poking internals. */
export function _peekCount(url: string): number {
    return counts.get(url) ?? 0;
}
