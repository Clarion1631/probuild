// scripts/download-hdri.ts
//
// Downloads 4 CC0 HDRIs from Poly Haven's public CDN into
// public/assets/room-designer/hdri/ for the Room Designer lighting presets.
//
// USAGE
//   npm run download-hdri           — full run (network)
//   npm run download-hdri -- --dry-run   — print planned work, no writes
//
// IDEMPOTENT
//   Skips any file that already exists locally with size > 1 MB.
//
// TARGET FILES (1k .hdr @ ~1–4 MB each)
//   interior_warm.hdr ← polyhaven id `cozy_living_room_2`
//   photo_studio.hdr  ← polyhaven id `studio_small_04`
//   overcast_sky.hdr  ← polyhaven id `kloppenheim_06`
//   evening_road.hdr  ← polyhaven id `evening_road_01`
//
// Poly Haven CDN URL pattern:
//   https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/<slug>_1k.hdr

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DRY_RUN = process.argv.includes("--dry-run");
const MIN_VALID_BYTES = 1 * 1024 * 1024; // 1 MB — anything smaller is a truncated / error response

const SCRIPT_DIR = path.dirname(
    typeof __filename !== "undefined" ? __filename : fileURLToPath(import.meta.url),
);
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const OUT_DIR = path.join(REPO_ROOT, "public", "assets", "room-designer", "hdri");

interface HdriSource {
    /** Local filename (must match the `file` field in hdri-presets.ts). */
    filename: string;
    /** Poly Haven slug (the URL segment, not the display name). */
    slug: string;
    /** Human-readable label for logging. */
    label: string;
}

const SOURCES: HdriSource[] = [
    { filename: "interior_warm.hdr", slug: "cozy_living_room_2", label: "Warm Interior" },
    { filename: "photo_studio.hdr", slug: "studio_small_04", label: "Bright Daylight" },
    { filename: "overcast_sky.hdr", slug: "kloppenheim_06", label: "Overcast" },
    { filename: "evening_road.hdr", slug: "evening_road_01", label: "Evening Warm" },
];

function cdnUrl(slug: string): string {
    return `https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/${slug}_1k.hdr`;
}

async function fileOk(p: string): Promise<boolean> {
    try {
        const s = await fs.stat(p);
        return s.isFile() && s.size >= MIN_VALID_BYTES;
    } catch {
        return false;
    }
}

async function download(src: HdriSource): Promise<{ ok: boolean; reason?: string; bytes?: number }> {
    const target = path.join(OUT_DIR, src.filename);

    if (await fileOk(target)) {
        return { ok: true, reason: "already present", bytes: (await fs.stat(target)).size };
    }

    const url = cdnUrl(src.slug);
    if (DRY_RUN) {
        return { ok: true, reason: `dry-run → ${url}` };
    }

    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) {
        return { ok: false, reason: `HTTP ${res.status} ${res.statusText}` };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < MIN_VALID_BYTES) {
        return { ok: false, reason: `response too small (${buf.length} bytes) — likely an error page` };
    }

    // Write atomically: .part → rename, so a crashed download never leaves a
    // half-file that the idempotency check would wrongly accept.
    const tmp = target + ".part";
    await fs.writeFile(tmp, buf);
    await fs.rename(tmp, target);

    return { ok: true, bytes: buf.length };
}

async function main() {
    console.log(`[download-hdri] target: ${OUT_DIR}`);
    if (!fsSync.existsSync(OUT_DIR)) {
        if (DRY_RUN) {
            console.log(`[download-hdri] would create ${OUT_DIR}`);
        } else {
            await fs.mkdir(OUT_DIR, { recursive: true });
        }
    }

    let ok = 0;
    let skipped = 0;
    let failed = 0;
    for (const src of SOURCES) {
        process.stdout.write(`  ${src.filename.padEnd(24)} `);
        try {
            const r = await download(src);
            if (r.ok) {
                if (r.reason === "already present") {
                    skipped++;
                    console.log(`SKIP (${(r.bytes! / 1024 / 1024).toFixed(1)} MB)`);
                } else if (r.reason?.startsWith("dry-run")) {
                    console.log(`DRY  ${r.reason.replace("dry-run → ", "")}`);
                } else {
                    ok++;
                    console.log(`OK   (${(r.bytes! / 1024 / 1024).toFixed(1)} MB)`);
                }
            } else {
                failed++;
                console.log(`FAIL ${r.reason}`);
            }
        } catch (e) {
            failed++;
            console.log(`FAIL ${(e as Error).message}`);
        }
    }

    console.log(`\n[download-hdri] done: ${ok} downloaded, ${skipped} skipped, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch((e) => {
    console.error("[download-hdri] fatal:", e);
    process.exit(1);
});
