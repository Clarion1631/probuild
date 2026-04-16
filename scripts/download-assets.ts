// scripts/download-assets.ts
//
// Downloads CC0 3D models (Poly Haven) and PBR textures (ambientCG) into
// Supabase Storage bucket `room-designer-assets`. Optimizes each asset
// locally, uploads to the bucket, and writes a manifest.json at the bucket
// root that Stage 2 will read to resolve real URLs into the static registries.
//
// USAGE
//   npm run assets:download        — full run (network + uploads)
//   npm run assets:download:dry    — print planned work, no network/writes
//
// IDEMPOTENT
//   Re-runs skip any asset that is already in the remote manifest AND whose
//   canonical output file exists in the bucket. Local staging is wiped after
//   each asset upload so on-disk state is never the signal.
//
// STAGE 1.5 EXPECTED RESULT
//   Models:   ok≈45 sourced entirely from Quaternius loose GLBs in
//             scripts/vendor/quaternius-glb/ — 37 original registry entries
//             (cabinets, appliances, fixtures, windows, doors) plus 8 new
//             entries for two optional categories (5 lighting, 3 plants).
//             A number of mappings are proxies (dryer reuses the washer model,
//             microwave reuses a small cabinet, sliding/pocket doors reuse
//             single-door variants, etc.) and carry "(proxy)" in their
//             manifest source string.
//             The Kenney Building / Furniture zip pipeline is still wired up
//             in `extractGlbFromKit` for future use but no MODEL_SOURCES
//             entry currently references it.
//   Textures: ok≈33 for hand-curated flooring/countertop/backsplash PBR sets
//   Paint:    not attempted (hasPBR: false entries skipped before mapping)

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import sharp from "sharp";
import { createClient } from "@supabase/supabase-js";
import { ASSET_REGISTRY, type Asset } from "../src/lib/room-designer/asset-registry";
import { MATERIAL_REGISTRY, type Material } from "../src/lib/room-designer/material-registry";

// ───────────────── .env loader ─────────────────
// Minimal dotenv-compatible loader so this script works without an explicit
// `--env-file=.env.local` flag or a new `dotenv` dev-dep. Loads in order so
// later files override earlier (matches Next.js env precedence).
loadEnvFiles([".env", ".env.local"]);

function loadEnvFiles(files: string[]) {
    // Resolve relative to repo root (one level up from scripts/), regardless of cwd.
    const scriptDir = path.dirname(
        typeof __filename !== "undefined" ? __filename : fileURLToPath(import.meta.url),
    );
    const repoRoot = path.resolve(scriptDir, "..");
    for (const f of files) {
        const abs = path.join(repoRoot, f);
        if (!fsSync.existsSync(abs)) continue;
        const raw = fsSync.readFileSync(abs, "utf8");
        for (const rawLine of raw.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line || line.startsWith("#")) continue;
            const eq = line.indexOf("=");
            if (eq < 1) continue;
            const k = line.slice(0, eq).trim();
            let v = line.slice(eq + 1).trim();
            if (v.startsWith('"') && v.endsWith('"')) {
                // Interpret common dotenv escape sequences inside double-quoted values.
                v = v.slice(1, -1).replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t");
            }
            // Skip injecting CR/LF that would corrupt URLs (they slip into Vercel-pulled envs).
            v = v.replace(/[\r\n]+/g, "");
            if (process.env[k] === undefined || process.env[k] === "") {
                process.env[k] = v;
            }
        }
    }
}

// ───────────────── config ─────────────────

const DRY_RUN = process.argv.includes("--dry-run");
const BUCKET = "room-designer-assets";

// Resolve paths without relying on __dirname (works in both CJS tsx and ESM).
const SCRIPT_DIR = path.dirname(
    typeof __filename !== "undefined" ? __filename : fileURLToPath(import.meta.url),
);
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const STAGING_ROOT = path.join(REPO_ROOT, "public", "assets", "room-designer");

// Curated id → source-asset mapping. Hand-review beats fragile auto-tag matching
// against APIs whose catalogs don't know about kitchen millwork.
//
// STAGE 1.5: All 45 current entries resolve to loose Quaternius GLBs in
// scripts/vendor/quaternius-glb/ (see `readGlbFromQuaternius`). Some
// Quaternius models double as stand-ins for assets the pack doesn't include
// natively (dryer reuses the washer, microwave reuses a small cabinet,
// sliding/pocket doors reuse single-door variants, etc.); those mappings
// carry `isProxy: true` so the manifest source string records a "(proxy)"
// suffix for downstream callers.
// The `kenney-building` / `kenney-furniture` variants stay on the discriminated
// union so the zip-extraction code path (extractGlbFromKit) can be rewired in
// the future without touching the source type.
type ModelSourceSpec =
    | { source: "quaternius"; file: string; isProxy?: boolean }
    | { source: "kenney-furniture"; file: string; isProxy?: boolean }
    | { source: "kenney-building"; file: string; isProxy?: boolean }
    | { source: "manual"; localPath: string };

const MODEL_SOURCES: Record<string, ModelSourceSpec> = {
    // ───────── Cabinets (10) — Quaternius loose GLBs
    "base-cabinet-24": { source: "quaternius", file: "Kitchen_1Drawers.glb" },
    "base-cabinet-36": { source: "quaternius", file: "Kitchen_2Drawers.glb" },
    "wall-cabinet-30": { source: "quaternius", file: "Kitchen_Cabinet1.glb" },
    "corner-cabinet": { source: "quaternius", file: "Kitchen_Cabinet2.glb" },
    "island-cabinet": { source: "quaternius", file: "Kitchen_3Drawers.glb" },
    "pantry-cabinet": { source: "quaternius", file: "Kitchen_CabinetSmall.glb", isProxy: true },
    "open-shelf": { source: "quaternius", file: "Shelf_Large.glb" },
    "drawer-base": { source: "quaternius", file: "Drawer_3.glb" },
    "sink-base-36": { source: "quaternius", file: "Kitchen_Sink.glb" },
    "glass-door-cabinet": { source: "quaternius", file: "Kitchen_Cabinet2.glb", isProxy: true },

    // ───────── Appliances (10) — Quaternius loose GLBs
    "refrigerator-french": { source: "quaternius", file: "Kitchen_Fridge.glb" },
    "stove-range-30": { source: "quaternius", file: "Kitchen_Oven.glb" },
    "oven-wall": { source: "quaternius", file: "Kitchen_Oven_Large.glb" },
    dishwasher: { source: "quaternius", file: "Drawer_5.glb", isProxy: true },
    "microwave-over-range": { source: "quaternius", file: "Kitchen_CabinetSmall.glb", isProxy: true },
    washer: { source: "quaternius", file: "Bathroom_WashingMachine.glb" },
    dryer: { source: "quaternius", file: "Bathroom_WashingMachine.glb", isProxy: true },
    "range-hood": { source: "quaternius", file: "Kitchen_Cabinet1.glb", isProxy: true },
    "wine-refrigerator": { source: "quaternius", file: "Kitchen_CabinetSmall.glb", isProxy: true },
    "ice-maker": { source: "quaternius", file: "Kitchen_1Drawers.glb", isProxy: true },

    // ───────── Fixtures (8) — Quaternius loose GLBs
    "kitchen-sink-farmhouse": { source: "quaternius", file: "Kitchen_Sink.glb", isProxy: true },
    "bathroom-sink-vessel": { source: "quaternius", file: "Bathroom_Sink.glb" },
    "toilet-standard": { source: "quaternius", file: "Bathroom_Toilet.glb" },
    "bathtub-freestanding": { source: "quaternius", file: "Bathroom_Bathtub.glb" },
    "shower-base": { source: "quaternius", file: "Bathroom_Shower1.glb" },
    "vanity-double": { source: "quaternius", file: "Drawer_4.glb", isProxy: true },
    "towel-bar": { source: "quaternius", file: "Bathroom_Towel.glb" },
    "bathroom-mirror": { source: "quaternius", file: "Bathroom_Mirror1.glb" },

    // ───────── Windows (5) — Quaternius loose GLBs
    "window-single-hung": { source: "quaternius", file: "Window_Small1.glb" },
    "window-double-hung": { source: "quaternius", file: "Window_Small2.glb" },
    "window-bay": { source: "quaternius", file: "Window_Large1.glb" },
    "window-casement": { source: "quaternius", file: "Window_Large2.glb" },
    "window-skylight": { source: "quaternius", file: "Window_Round1.glb", isProxy: true },

    // ───────── Doors (4) — Quaternius loose GLBs
    "door-single": { source: "quaternius", file: "Door_1.glb" },
    "door-double": { source: "quaternius", file: "Door_Double.glb" },
    "door-sliding": { source: "quaternius", file: "Door_3.glb", isProxy: true },
    "door-pocket": { source: "quaternius", file: "Door_2.glb", isProxy: true },

    // ───────── Lighting (5) — Quaternius loose GLBs (Stage 1.5 addition)
    "ceiling-light-1": { source: "quaternius", file: "Light_Ceiling1.glb" },
    "ceiling-light-2": { source: "quaternius", file: "Light_Ceiling2.glb" },
    chandelier: { source: "quaternius", file: "Light_Chandelier.glb" },
    "floor-lamp": { source: "quaternius", file: "Light_Floor1.glb" },
    "desk-lamp": { source: "quaternius", file: "Light_Desk.glb" },

    // ───────── Plants (3) — Quaternius loose GLBs (Stage 1.5 addition)
    "houseplant-small": { source: "quaternius", file: "Houseplant_1.glb" },
    "houseplant-medium": { source: "quaternius", file: "Houseplant_3.glb" },
    "houseplant-large": { source: "quaternius", file: "Houseplant_5.glb" },
};

// ───────────────── kit zip registry ─────────────────

const VENDOR_DIR = path.resolve(REPO_ROOT, "scripts", "vendor");

// Path to loose Quaternius GLBs. Superseded the old
// `quaternius-ultimate-house-interior.zip` extraction path — individual
// models now live as top-level .glb files in this directory, matched by
// exact filename (case-sensitive). `readGlbFromQuaternius` below reads
// from here; `extractGlbFromKit` is NOT used for quaternius anymore.
const QUATERNIUS_LOOSE_DIR = path.resolve(VENDOR_DIR, "quaternius-glb");

// NOTE: `quaternius` is retained in KIT_ZIPS only so that `KitId` remains a
// stable keyof-based union. Actual quaternius GLBs are loaded from loose
// files in scripts/vendor/quaternius-glb/ via `readGlbFromQuaternius`, NOT
// from this zip. The zip file is no longer expected to exist on disk.
const KIT_ZIPS = {
    quaternius: "quaternius-ultimate-house-interior.zip",
    "kenney-furniture": "kenney_furniture-kit.zip",
    "kenney-building": "kenney_building-kit.zip",
} as const;
type KitId = keyof typeof KIT_ZIPS;

async function readGlbFromQuaternius(filename: string): Promise<Buffer> {
    const abs = path.join(QUATERNIUS_LOOSE_DIR, filename);
    if (!fsSync.existsSync(abs)) {
        throw new Error(
            `Missing Quaternius GLB: ${abs}\n` +
                `Place ${filename} into scripts/vendor/quaternius-glb/.`,
        );
    }
    return fs.readFile(abs);
}

// ambientCG asset IDs chosen from their public catalog. Verified each to be
// a close semantic match to the registry id. Slugs use ambientCG's canonical
// naming (e.g. "WoodFloor045"). If a slug 404s on first fetch, log and skip —
// ambientCG does retire assets occasionally; re-pick from their catalog and
// update the map.
const TEXTURE_SOURCES: Record<string, { source: "ambientcg"; slug: string }> = {
    // Flooring
    "hardwood-oak-natural": { source: "ambientcg", slug: "WoodFloor045" },
    "hardwood-walnut-dark": { source: "ambientcg", slug: "WoodFloor051" },
    "tile-white-12x24": { source: "ambientcg", slug: "Tiles074" },
    "tile-gray-marble": { source: "ambientcg", slug: "Marble012" },
    "tile-hex-white": { source: "ambientcg", slug: "Tiles093" },
    "concrete-polished": { source: "ambientcg", slug: "Concrete033" },
    "vinyl-plank-gray": { source: "ambientcg", slug: "WoodFloor033" },
    "carpet-neutral": { source: "ambientcg", slug: "Carpet009" },
    travertine: { source: "ambientcg", slug: "Travertine005" },
    "slate-dark": { source: "ambientcg", slug: "Rock030" },
    terracotta: { source: "ambientcg", slug: "GlazedTerracotta001" },
    bamboo: { source: "ambientcg", slug: "WoodFloor041" },
    cork: { source: "ambientcg", slug: "Cork002" },
    "porcelain-wood-look": { source: "ambientcg", slug: "WoodFloor043" },
    "tile-herringbone": { source: "ambientcg", slug: "WoodFloor038" },

    // Countertop
    "granite-black": { source: "ambientcg", slug: "Rock029" },
    "marble-white-carrara": { source: "ambientcg", slug: "Marble006" },
    "quartz-white": { source: "ambientcg", slug: "Marble020" },
    "quartz-gray": { source: "ambientcg", slug: "Marble023" },
    "butcher-block": { source: "ambientcg", slug: "Wood066" },
    "concrete-counter": { source: "ambientcg", slug: "Concrete034" },
    "laminate-white": { source: "ambientcg", slug: "Plastic010" },
    soapstone: { source: "ambientcg", slug: "Rock048" },

    // Backsplash
    "subway-white": { source: "ambientcg", slug: "Tiles101" },
    "subway-gray": { source: "ambientcg", slug: "Tiles102" },
    "hex-white-small": { source: "ambientcg", slug: "Tiles061" },
    "penny-round": { source: "ambientcg", slug: "Tiles076" },
    arabesque: { source: "ambientcg", slug: "Tiles108" },
    zellige: { source: "ambientcg", slug: "Tiles089" },
    "brick-red": { source: "ambientcg", slug: "Bricks059" },
    "chevron-white": { source: "ambientcg", slug: "Tiles087" },
    "geometric-black": { source: "ambientcg", slug: "Tiles095" },
    "fish-scale": { source: "ambientcg", slug: "Tiles083" },
};

// ───────────────── types ─────────────────

type ManifestEntry = {
    id: string;
    kind: "model" | "texture";
    /** For textures this is the folder base URL (append albedo.jpg etc.). For models it's the full .glb URL. */
    url: string;
    thumbnailUrl: string;
    license: "CC0" | "CC-BY" | "MIT";
    source: string; // e.g. "ambientcg:WoodFloor045"
    uploadedAt: string; // ISO 8601
};

type Manifest = {
    generatedAt: string;
    entries: ManifestEntry[];
};

type Report = {
    models: { ok: number; skipped: number; failed: number };
    textures: { ok: number; skipped: number; failed: number };
};

// ───────────────── supabase client ─────────────────

// Not constructed until main() so --dry-run works without env vars set.
let supabase: ReturnType<typeof createClient> | null = null;

function getSupabase() {
    if (!supabase) {
        supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!, {
            auth: { persistSession: false },
        });
    }
    return supabase;
}

// ───────────────── utilities ─────────────────

function requireEnv(keys: string[]) {
    const missing = keys.filter((k) => !process.env[k]);
    if (missing.length) {
        throw new Error(
            `Missing required env vars: ${missing.join(", ")}. Set them in .env.local or export them in your shell.`,
        );
    }
}

async function ensureDirs() {
    await fs.mkdir(STAGING_ROOT, { recursive: true });
}

async function rmStaging(dir: string) {
    await fs.rm(dir, { recursive: true, force: true });
}

async function fetchBuffer(url: string): Promise<Buffer> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch ${res.status} ${res.statusText}: ${url}`);
    return Buffer.from(await res.arrayBuffer());
}

async function loadManifestFromStorage(): Promise<ManifestEntry[]> {
    if (DRY_RUN) return [];
    const { data, error } = await getSupabase().storage.from(BUCKET).download("manifest.json");
    if (error) {
        // Supabase returns 400 "Object not found" for missing files.
        const msg = (error as { message?: string }).message ?? "";
        if (msg.toLowerCase().includes("not found") || msg.toLowerCase().includes("does not exist")) {
            return [];
        }
        throw error;
    }
    const text = await data.text();
    const parsed = JSON.parse(text) as Manifest;
    return Array.isArray(parsed.entries) ? parsed.entries : [];
}

async function remoteObjectExists(prefix: string, filename: string): Promise<boolean> {
    if (DRY_RUN) return false;
    const { data, error } = await getSupabase().storage.from(BUCKET).list(prefix, {
        limit: 1,
        search: filename,
    });
    if (error) throw error;
    return Array.isArray(data) && data.some((f) => f.name === filename);
}

async function uploadBuffer(remoteKey: string, body: Buffer, contentType: string): Promise<string> {
    if (DRY_RUN) {
        return `https://<dry-run>/${BUCKET}/${remoteKey}`;
    }
    const { error } = await getSupabase().storage.from(BUCKET).upload(remoteKey, body, {
        contentType,
        upsert: true,
    });
    if (error) throw error;
    const { data } = getSupabase().storage.from(BUCKET).getPublicUrl(remoteKey);
    return data.publicUrl;
}

function mergeManifests(prev: ManifestEntry[], next: ManifestEntry[]): ManifestEntry[] {
    const byId = new Map<string, ManifestEntry>();
    for (const e of prev) byId.set(e.id, e);
    for (const e of next) byId.set(e.id, e); // next wins
    return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
}

// ───────────────── zip-slip guard ─────────────────

function assertSafeZipEntry(entryName: string, destDir: string): string {
    const resolved = path.resolve(destDir, entryName);
    const root = path.resolve(destDir) + path.sep;
    if (!resolved.startsWith(root) && resolved !== path.resolve(destDir)) {
        throw new Error(`zip-slip blocked: ${entryName}`);
    }
    return resolved;
}

// Name-only traversal check — assertSafeZipEntry above expects a destDir
// because it's for on-disk extraction. We stream model GLBs straight into a
// Buffer and never touch disk, so all we need is to reject absolute paths
// and `..` segments in entry names before feeding them to AdmZip.
function assertSafeEntryName(entryName: string): void {
    const normalized = entryName.replace(/\\/g, "/");
    if (path.isAbsolute(normalized) || normalized.split("/").some((seg) => seg === "..")) {
        throw new Error(`zip-slip blocked: ${entryName}`);
    }
}

// ───────────────── kit zip extraction ─────────────────

const kitZipCache = new Map<KitId, AdmZip>();

function openKitZip(kit: KitId): AdmZip {
    const cached = kitZipCache.get(kit);
    if (cached) return cached;
    const zipPath = path.join(VENDOR_DIR, KIT_ZIPS[kit]);
    if (!fsSync.existsSync(zipPath)) {
        throw new Error(
            `Missing kit zip: ${zipPath}\n` +
                `Download ${KIT_ZIPS[kit]} from its source and place it in scripts/vendor/. ` +
                `See scripts/vendor/README.md for links and licenses.`,
        );
    }
    const zip = new AdmZip(zipPath);
    kitZipCache.set(kit, zip);
    return zip;
}

function extractGlbFromKit(kit: KitId, filename: string): Buffer {
    const zip = openKitZip(kit);
    // Kenney/Quaternius nest files under Models/ or similar — match by
    // basename, case-insensitive, so we don't have to know the internal layout.
    const wanted = filename.toLowerCase();
    const entry = zip
        .getEntries()
        .find((e) => !e.isDirectory && path.basename(e.entryName).toLowerCase() === wanted);
    if (!entry) {
        const available = zip
            .getEntries()
            .filter((e) => !e.isDirectory && /\.(glb|gltf)$/i.test(e.entryName))
            .map((e) => path.basename(e.entryName))
            .slice(0, 20);
        throw new Error(
            `${filename} not in ${KIT_ZIPS[kit]}. First 20 GLB/GLTF entries:\n  ${available.join("\n  ")}`,
        );
    }
    assertSafeEntryName(entry.entryName);
    return entry.getData();
}

// ───────────────── ambientCG ─────────────────

// Maps ambientCG's file suffix conventions to our canonical names.
const TEXTURE_MAP_KEYS: Array<{ out: string; suffixes: string[] }> = [
    { out: "albedo", suffixes: ["_Color.jpg", "_Color.png", "_Diffuse.jpg"] },
    { out: "normal", suffixes: ["_NormalGL.jpg", "_NormalGL.png", "_Normal.jpg", "_Normal.png"] },
    { out: "roughness", suffixes: ["_Roughness.jpg", "_Roughness.png"] },
    { out: "ao", suffixes: ["_AmbientOcclusion.jpg", "_AmbientOcclusion.png"] },
    { out: "metal", suffixes: ["_Metalness.jpg", "_Metalness.png"] },
];

type AmbientCgDownload = {
    fullDownloadPath: string;
    attribute: string; // e.g. "1K-JPG"
    fileName?: string;
    zipContent?: unknown;
};

async function pickAmbientCgZipUrl(slug: string): Promise<string> {
    const apiUrl = `https://ambientcg.com/api/v2/full_json?id=${encodeURIComponent(slug)}&include=downloadData`;
    const res = await fetch(apiUrl, { headers: { "User-Agent": "probuild-room-designer/1.0" } });
    if (!res.ok) throw new Error(`ambientCG api ${res.status} for ${slug}`);
    // deno-lint-ignore no-explicit-any
    const json = (await res.json()) as any;
    const asset = json?.foundAssets?.[0];
    if (!asset) throw new Error(`ambientCG returned no asset for slug "${slug}"`);
    const downloads: AmbientCgDownload[] = [];
    // ambientCG shape: downloadFolders is a dict keyed by folder name (e.g.
    // "default"), NOT an array. downloadFiletypeCategories is likewise keyed
    // (e.g. "zip"). Both need Object.values to iterate correctly.
    const folders = Object.values(asset.downloadFolders ?? {}) as Array<{
        downloadFiletypeCategories?: Record<string, { downloads?: AmbientCgDownload[] }>;
    }>;
    for (const folder of folders) {
        const cats = folder?.downloadFiletypeCategories ?? {};
        for (const cat of Object.values(cats) as Array<{ downloads?: AmbientCgDownload[] }>) {
            if (Array.isArray(cat?.downloads)) downloads.push(...cat.downloads);
        }
    }
    const preferred = downloads.find((d) => d.attribute === "1K-JPG") ?? downloads.find((d) => /1K/.test(d.attribute));
    if (!preferred) throw new Error(`ambientCG ${slug}: no 1K-JPG download available`);
    return preferred.fullDownloadPath;
}

async function downloadTexture(
    material: Material,
    mapping: { source: "ambientcg"; slug: string },
): Promise<ManifestEntry> {
    const stagingDir = path.join(STAGING_ROOT, "textures", material.category, material.id);
    const remotePrefix = `textures/${material.category}/${material.id}`;

    if (DRY_RUN) {
        console.log(`[dry-run:texture] ${material.id} ← ambientCG:${mapping.slug} → ${remotePrefix}/{albedo,normal,roughness,ao,metal}.jpg`);
        return {
            id: material.id,
            kind: "texture",
            url: `https://<dry-run>/${BUCKET}/${remotePrefix}/`,
            thumbnailUrl: `https://<dry-run>/${BUCKET}/thumbnails/${material.id}.webp`,
            license: "CC0",
            source: `ambientcg:${mapping.slug}`,
            uploadedAt: new Date().toISOString(),
        };
    }

    await fs.mkdir(stagingDir, { recursive: true });
    try {
        const zipUrl = await pickAmbientCgZipUrl(mapping.slug);
        const zipBuf = await fetchBuffer(zipUrl);
        const zip = new AdmZip(zipBuf);

        // Resolve which zip entry maps to each canonical key (albedo/normal/...).
        const entries = zip.getEntries();
        const chosen: Record<string, AdmZip.IZipEntry> = {};
        for (const { out, suffixes } of TEXTURE_MAP_KEYS) {
            const match = entries.find((e) => suffixes.some((s) => e.entryName.endsWith(s)));
            if (match) chosen[out] = match;
        }
        if (!chosen.albedo) throw new Error(`ambientCG ${mapping.slug}: no color/albedo map in zip`);

        // Zip-slip guard + extract + resize + upload, per canonical key.
        for (const [outKey, entry] of Object.entries(chosen)) {
            assertSafeZipEntry(entry.entryName, stagingDir);
            const buf = entry.getData();
            const resized = await sharp(buf).resize(1024, 1024, { fit: "cover" }).jpeg({ quality: 85 }).toBuffer();
            await uploadBuffer(`${remotePrefix}/${outKey}.jpg`, resized, "image/jpeg");
        }

        // Thumbnail from albedo.
        const albedoBuf = chosen.albedo.getData();
        const thumb = await sharp(albedoBuf).resize(200, 200, { fit: "cover" }).webp({ quality: 85 }).toBuffer();
        const thumbnailUrl = await uploadBuffer(`thumbnails/${material.id}.webp`, thumb, "image/webp");

        const { data } = getSupabase().storage.from(BUCKET).getPublicUrl(`${remotePrefix}/`);
        return {
            id: material.id,
            kind: "texture",
            url: data.publicUrl,
            thumbnailUrl,
            license: "CC0",
            source: `ambientcg:${mapping.slug}`,
            uploadedAt: new Date().toISOString(),
        };
    } finally {
        await rmStaging(stagingDir);
    }
}

// ───────────────── models (Stage 1.5: kenney + quaternius local zips) ─────────────────

async function downloadModel(asset: Asset, mapping: ModelSourceSpec): Promise<ManifestEntry> {
    const remotePrefix = `models/${asset.subcategory}/`;
    const remoteName = `${asset.id}.glb`;
    const remoteKey = `${remotePrefix}${remoteName}`;

    // Dry-run short-circuit BEFORE touching the zip, so `npm run assets:download
    // -- --dry-run` works even when the user hasn't placed vendor zips yet.
    if (DRY_RUN) {
        const tag =
            mapping.source === "manual"
                ? `manual:${mapping.localPath}`
                : `${mapping.source}:${mapping.file}${mapping.isProxy ? " (proxy)" : ""}`;
        console.log(`[dry-run:model] ${asset.id} ← ${tag} → ${remoteKey}`);
        return {
            id: asset.id,
            kind: "model",
            url: `https://<dry-run>/${BUCKET}/${remoteKey}`,
            thumbnailUrl: "",
            license: "CC0",
            source: tag,
            uploadedAt: new Date().toISOString(),
        };
    }

    let buffer: Buffer;
    let sourceTag: string;
    if (mapping.source === "manual") {
        buffer = await fs.readFile(mapping.localPath);
        sourceTag = `manual:${path.basename(mapping.localPath)}`;
    } else if (mapping.source === "quaternius") {
        // Quaternius models come from loose GLBs in scripts/vendor/quaternius-glb/,
        // NOT from a kit zip. See `readGlbFromQuaternius` and the KIT_ZIPS note.
        buffer = await readGlbFromQuaternius(mapping.file);
        sourceTag = `quaternius:${mapping.file}${mapping.isProxy ? " (proxy)" : ""}`;
    } else {
        buffer = extractGlbFromKit(mapping.source, mapping.file);
        sourceTag = `${mapping.source}:${mapping.file}${mapping.isProxy ? " (proxy)" : ""}`;
    }

    const publicUrl = await uploadBuffer(remoteKey, buffer, "model/gltf-binary");

    return {
        id: asset.id,
        kind: "model",
        url: publicUrl,
        // Stage 2: render per-asset thumbnails via headless three.js. For now
        // clients fall back to the category icon in the asset panel.
        thumbnailUrl: "",
        license: "CC0",
        source: sourceTag,
        uploadedAt: new Date().toISOString(),
    };
}

// ───────────────── idempotency ─────────────────

async function isTextureAlreadyUploaded(material: Material, manifest: ManifestEntry[]): Promise<boolean> {
    const inManifest = manifest.some((e) => e.id === material.id);
    if (!inManifest) return false;
    return remoteObjectExists(`textures/${material.category}/${material.id}`, "albedo.jpg");
}

async function isModelAlreadyUploaded(asset: Asset, manifest: ManifestEntry[]): Promise<boolean> {
    const inManifest = manifest.some((e) => e.id === asset.id);
    if (!inManifest) return false;
    return remoteObjectExists(`models/${asset.subcategory}`, `${asset.id}.glb`);
}

// ───────────────── main ─────────────────

async function main() {
    if (!DRY_RUN) requireEnv(["SUPABASE_URL", "SUPABASE_SERVICE_KEY"]);
    await ensureDirs();

    console.log(DRY_RUN ? "── DRY RUN (no network, no uploads) ──" : "── Stage 1 asset download ──");

    const existingManifest = await loadManifestFromStorage();
    const newEntries: ManifestEntry[] = [];
    const report: Report = {
        models: { ok: 0, skipped: 0, failed: 0 },
        textures: { ok: 0, skipped: 0, failed: 0 },
    };

    // Models — skipped en masse in Stage 1 because MODEL_SOURCES is empty.
    for (const asset of ASSET_REGISTRY) {
        const mapping = MODEL_SOURCES[asset.id];
        if (!mapping) {
            report.models.skipped++;
            continue;
        }
        if (await isModelAlreadyUploaded(asset, existingManifest)) {
            report.models.skipped++;
            continue;
        }
        try {
            const entry = await downloadModel(asset, mapping);
            newEntries.push(entry);
            report.models.ok++;
            console.log(`  ✓ model: ${asset.id}`);
        } catch (err) {
            console.warn(`  ✗ model: ${asset.id} — ${(err as Error).message}`);
            report.models.failed++;
        }
    }

    // Textures — hand-curated ambientCG matches. We gate on TEXTURE_SOURCES
    // membership (not material.hasPBR) because `hasPBR` is a *runtime rendering*
    // hint the Stage-2 canvas uses to decide whether to load a PBR map set.
    // Plenty of materials ship with `hasPBR: false` as flat-color placeholders
    // but still have a legitimate slug we want pre-downloaded so Stage 2 can
    // flip the flag without re-running bandwidth.
    for (const material of MATERIAL_REGISTRY) {
        const mapping = TEXTURE_SOURCES[material.id];
        if (!mapping) {
            report.textures.skipped++;
            continue;
        }
        if (await isTextureAlreadyUploaded(material, existingManifest)) {
            report.textures.skipped++;
            console.log(`  · texture: ${material.id} (already uploaded, skipped)`);
            continue;
        }
        try {
            const entry = await downloadTexture(material, mapping);
            newEntries.push(entry);
            report.textures.ok++;
            console.log(`  ✓ texture: ${material.id}`);
        } catch (err) {
            console.warn(`  ✗ texture: ${material.id} — ${(err as Error).message}`);
            report.textures.failed++;
        }
    }

    // Persist merged manifest.
    const merged = mergeManifests(existingManifest, newEntries);
    const manifestBody = Buffer.from(
        JSON.stringify({ generatedAt: new Date().toISOString(), entries: merged } satisfies Manifest, null, 2),
    );
    if (!DRY_RUN && newEntries.length > 0) {
        await uploadBuffer("manifest.json", manifestBody, "application/json");
    }

    // Summary.
    console.log("\n── summary ──");
    console.log(
        `models   ok=${report.models.ok.toString().padStart(2)} skipped=${report.models.skipped.toString().padStart(2)} failed=${report.models.failed.toString().padStart(2)}`,
    );
    console.log(
        `textures ok=${report.textures.ok.toString().padStart(2)} skipped=${report.textures.skipped.toString().padStart(2)} failed=${report.textures.failed.toString().padStart(2)}`,
    );
    if (DRY_RUN) {
        console.log("\n(dry-run: no network calls, no uploads, no manifest write)");
    } else {
        console.log(
            `\nmanifest: ${newEntries.length > 0 ? "written" : "unchanged"} (total ${merged.length} entries)`,
        );
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});

// Silence the unused-existsSync import in strict lint configs while keeping the
// import available if future helpers need a sync existence check.
void existsSync;
