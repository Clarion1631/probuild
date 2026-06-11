// Room Studio - product library (org-wide custom finishes + placeable
// products from real vendors, stored in the DB).
//
// The studio's static catalog stays code-seeded; library entries layer on top
// through two runtime registries. `getFinish` and `getItemDef` consult these
// as fallbacks, so a library id saved in a design renders the moment the
// library has loaded.

import type { Finish, FinishKind } from "./materials";
import { registerLibraryFinishes } from "./materials";
import type { CatalogItem, Category, MountType } from "./catalog";
import { registerLibraryProducts } from "./catalog";
import { inches } from "./units";

export interface LibraryFinish {
  id: string;
  kind: FinishKind;
  name: string;
  hex: string;
  vendor?: string | null;
  sku?: string | null;
  priceNote?: string | null;
  notes?: string | null;
  sourceUrl?: string | null;
}

export interface LibraryProduct {
  id: string;
  name: string;
  vendor?: string | null;
  sku?: string | null;
  category: Category;
  mesh: string;
  widthIn: number;
  depthIn: number;
  heightIn: number;
  mount: MountType;
  elevationIn?: number | null;
  price?: number | null;
  finishes?: Record<string, string> | null;
  sourceUrl?: string | null;
  notes?: string | null;
}

/** Library finish ids are namespaced so they can never collide with seeds. */
export const finishId = (id: string) => `lib-${id}`;
/** Library product defIds, ditto. */
export const productDefId = (id: string) => `prod-${id}`;

export function toFinish(f: LibraryFinish): Finish {
  return {
    id: finishId(f.id),
    name: f.vendor ? `${f.name} (${f.vendor})` : f.name,
    kind: f.kind,
    hex: f.hex,
    roughness: f.kind === "paint" ? 0.94 : f.kind === "counter" ? 0.25 : f.kind === "tile" ? 0.3 : 0.55,
  };
}

export function toCatalogItem(p: LibraryProduct): CatalogItem {
  return {
    id: productDefId(p.id),
    name: p.name,
    category: p.category,
    mesh: p.mesh,
    w: inches(p.widthIn),
    d: inches(p.depthIn),
    h: inches(p.heightIn),
    mount: p.mount,
    elevation: p.elevationIn != null ? inches(p.elevationIn) : undefined,
    wallSnap: p.mount === "wall" || p.category === "cabinets" || p.category === "appliances",
    finishes: p.finishes ?? undefined,
    tags: [p.vendor ?? "", p.sku ?? "", "library"].filter(Boolean) as string[],
  };
}

// ---------------------------------------------------------------------------
// Client-side loader: fetch once, register, notify subscribers.
// ---------------------------------------------------------------------------

export interface LibraryData {
  finishes: LibraryFinish[];
  products: LibraryProduct[];
}

let current: LibraryData = { finishes: [], products: [] };
let version = 0;
const listeners = new Set<() => void>();

export function getLibrary(): LibraryData {
  return current;
}

export function getLibraryVersion(): number {
  return version;
}

export function subscribeLibrary(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setLibrary(data: LibraryData): void {
  current = data;
  registerLibraryFinishes(data.finishes.map(toFinish));
  registerLibraryProducts(data.products.map(toCatalogItem));
  version += 1;
  for (const fn of listeners) fn();
}

let loadPromise: Promise<void> | null = null;

/** Fetch the library once per page; safe to call from anywhere client-side. */
export function ensureLibraryLoaded(): Promise<void> {
  if (loadPromise) return loadPromise;
  loadPromise = fetch("/api/studio-library")
    .then((r) => (r.ok ? r.json() : { finishes: [], products: [] }))
    .then((data: LibraryData) => setLibrary(data))
    .catch(() => {
      loadPromise = null; // allow retry on the next call
    }) as Promise<void>;
  return loadPromise;
}
