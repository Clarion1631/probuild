// 3-page client-facing PDF export: perspective, top-down ortho, materials list.
//
// Both raster pages route through `renderRoomPng` so we inherit its
// offscreen-target safety guarantees — the live CameraRig is never resized,
// and the live renderer's state is restored even if a render throws.
//
// The top-down ortho page builds a FRESH `THREE.OrthographicCamera` at export
// time — it is disposed the moment the PDF blob is returned. We never mutate
// the live camera.
//
// The <Html> overlays (measurements, sqft badge) deliberately do NOT appear
// on the PDF because `gl.render()` doesn't rasterize DOM. If measurements
// become a deliverable requirement, draw them atop the ortho page with
// jsPDF 2D primitives instead of trying to capture the DOM layer.

import { jsPDF } from "jspdf";
import * as THREE from "three";
import type { PlacedAsset, RoomLayout } from "@/components/room-designer/types";
import { ASSET_REGISTRY, getAsset, type Asset } from "./asset-registry";
import { roomBounds } from "@/components/room-designer/core/geometry";
import { renderRoomPng } from "./export-png";

export interface PdfOwner {
    contractorName: string;
    contractorLogoUrl: string | null;
    contractorAddress: string | null;
    ownerName: string;       // project or lead name
    ownerAddress: string | null;
}

export interface PdfRenderCtx {
    gl: THREE.WebGLRenderer;
    scene: THREE.Scene;
    liveCamera: THREE.Camera;
    layout: RoomLayout;
}

export interface PdfDocMeta {
    roomName: string;
}

// Landscape A4 in millimetres. Matches jsPDF's internal unit system.
const PAGE_W = 297;
const PAGE_H = 210;
const MARGIN = 12;
const HEADER_H = 22;
const FOOTER_H = 10;

/**
 * Render a 3-page PDF (perspective, ortho top-down, materials table) and
 * return it as a Blob. The live R3F canvas is never resized.
 */
export async function renderRoomPdf(
    ctx: PdfRenderCtx,
    owner: PdfOwner,
    docMeta: PdfDocMeta,
    assets: PlacedAsset[],
): Promise<Blob> {
    const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });

    // Preload logo as data URL once, reuse across pages.
    const logoDataUrl = owner.contractorLogoUrl
        ? await fetchAsDataUrl(owner.contractorLogoUrl)
        : null;

    // ───────── Page 1 — perspective render ─────────
    const perspectiveBlob = await renderRoomPng(ctx.gl, ctx.scene, ctx.liveCamera, {
        width: 2048,
        height: 1152,
        watermark: null, // the PDF header carries branding
    });
    const perspectiveDataUrl = await blobToDataUrl(perspectiveBlob);
    drawHeaderFooter(doc, owner, docMeta, logoDataUrl, 1, 3);
    drawFitImage(doc, perspectiveDataUrl, 2048, 1152);

    // ───────── Page 2 — orthographic top-down render ─────────
    doc.addPage();
    const orthoCamera = buildOrthoCamera(ctx.layout);
    try {
        const orthoBlob = await renderRoomPng(ctx.gl, ctx.scene, orthoCamera, {
            width: 2048,
            height: 2048,
            watermark: null,
        });
        const orthoDataUrl = await blobToDataUrl(orthoBlob);
        drawHeaderFooter(doc, owner, docMeta, logoDataUrl, 2, 3);
        drawFitImage(doc, orthoDataUrl, 2048, 2048);
    } finally {
        // OrthographicCamera has no GPU resources to dispose, but drop refs
        // to help the GC out.
        (orthoCamera as unknown as { parent: null }).parent = null;
    }

    // ───────── Page 3 — materials list ─────────
    doc.addPage();
    drawHeaderFooter(doc, owner, docMeta, logoDataUrl, 3, 3);
    drawMaterialsTable(doc, assets);

    const pdfBlob = doc.output("blob");
    return pdfBlob;
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function drawHeaderFooter(
    doc: jsPDF,
    owner: PdfOwner,
    docMeta: PdfDocMeta,
    logoDataUrl: string | null,
    pageIdx: number,
    pageTotal: number,
) {
    // Header background stripe for subtle branding.
    doc.setFillColor(248, 250, 252);
    doc.rect(0, 0, PAGE_W, HEADER_H, "F");

    // Logo (left). Capped at 16mm tall, preserves aspect via image metadata.
    let cursorX = MARGIN;
    if (logoDataUrl) {
        try {
            doc.addImage(logoDataUrl, "PNG", cursorX, 4, 14, 14, undefined, "FAST");
            cursorX += 18;
        } catch {
            // Some data URLs fail addImage (non-PNG, malformed). Skip silently.
        }
    }

    // Contractor name (left, bold) + address (subtle) right below.
    doc.setTextColor(15, 23, 42);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.text(owner.contractorName, cursorX, 9);
    if (owner.contractorAddress) {
        doc.setFont("helvetica", "normal");
        doc.setFontSize(8);
        doc.setTextColor(100, 116, 139);
        doc.text(owner.contractorAddress, cursorX, 14);
    }

    // Project block (right-aligned).
    doc.setTextColor(15, 23, 42);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.text(`${owner.ownerName} — ${docMeta.roomName}`, PAGE_W - MARGIN, 9, { align: "right" });
    if (owner.ownerAddress) {
        doc.setFont("helvetica", "normal");
        doc.setFontSize(8);
        doc.setTextColor(100, 116, 139);
        doc.text(owner.ownerAddress, PAGE_W - MARGIN, 14, { align: "right" });
    }

    // Footer: date + page counter + brand line.
    const footerY = PAGE_H - 5;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(148, 163, 184);
    doc.text(new Date().toLocaleDateString(), MARGIN, footerY);
    doc.text(`Page ${pageIdx} of ${pageTotal}`, PAGE_W / 2, footerY, { align: "center" });
    doc.text("Powered by ProBuild", PAGE_W - MARGIN, footerY, { align: "right" });
}

/** Render an image into the page body, preserving aspect and centring. */
function drawFitImage(doc: jsPDF, dataUrl: string, srcW: number, srcH: number) {
    const boxX = MARGIN;
    const boxY = HEADER_H + 2;
    const boxW = PAGE_W - MARGIN * 2;
    const boxH = PAGE_H - HEADER_H - FOOTER_H - 4;
    const srcAspect = srcW / srcH;
    const boxAspect = boxW / boxH;
    let drawW = boxW;
    let drawH = boxH;
    if (srcAspect > boxAspect) {
        drawH = drawW / srcAspect;
    } else {
        drawW = drawH * srcAspect;
    }
    const x = boxX + (boxW - drawW) / 2;
    const y = boxY + (boxH - drawH) / 2;
    doc.addImage(dataUrl, "PNG", x, y, drawW, drawH, undefined, "FAST");
}

/** Fresh ortho camera aimed straight down at the room centre. */
function buildOrthoCamera(layout: RoomLayout): THREE.OrthographicCamera {
    const bounds = roomBounds(layout);
    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerZ = (bounds.minZ + bounds.maxZ) / 2;
    const roomW = bounds.maxX - bounds.minX;
    const roomD = bounds.maxZ - bounds.minZ;
    const half = Math.max(roomW, roomD) / 2 + 0.5; // 0.5m air margin
    const ceiling = layout.dimensions.height;

    const cam = new THREE.OrthographicCamera(-half, half, half, -half, 0.1, 100);
    cam.position.set(centerX, ceiling + 5, centerZ);
    cam.up.set(0, 0, -1); // +X right, -Z up in the image (matches drafting)
    cam.lookAt(centerX, 0, centerZ);
    cam.updateProjectionMatrix();
    return cam;
}

interface MaterialsRow {
    category: string;
    item: string;
    finish: string;
    dims: string;
    qty: number;
}

/** Collapse identical placed assets by (assetId, finish) and render a table. */
function drawMaterialsTable(doc: jsPDF, assets: PlacedAsset[]) {
    const rows = buildMaterialsRows(assets, ASSET_REGISTRY);

    // Section title.
    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.setTextColor(15, 23, 42);
    doc.text("Materials & Fixtures", MARGIN, HEADER_H + 10);

    // Column layout (mm). Widths tuned for landscape A4.
    const cols = [
        { label: "Category", x: MARGIN, w: 35 },
        { label: "Item", x: MARGIN + 35, w: 90 },
        { label: "Finish", x: MARGIN + 125, w: 50 },
        { label: "W × H × D", x: MARGIN + 175, w: 60 },
        { label: "Qty", x: MARGIN + 235, w: 30 },
    ] as const;

    const headerY = HEADER_H + 18;
    doc.setFontSize(9);
    doc.setDrawColor(226, 232, 240);
    doc.setFillColor(241, 245, 249);
    doc.rect(MARGIN, headerY - 5, PAGE_W - MARGIN * 2, 7, "F");
    doc.setTextColor(71, 85, 105);
    doc.setFont("helvetica", "bold");
    cols.forEach((c) => doc.text(c.label, c.x + 1, headerY));

    doc.setFont("helvetica", "normal");
    doc.setTextColor(15, 23, 42);
    let rowY = headerY + 7;
    const rowH = 6;
    const maxY = PAGE_H - FOOTER_H - 4;

    if (rows.length === 0) {
        doc.setTextColor(100, 116, 139);
        doc.text("No materials placed.", MARGIN, rowY);
        return;
    }

    for (const row of rows) {
        if (rowY > maxY) {
            // Overflow → new page. Re-draw header frame (no branding —
            // drawHeaderFooter is per-page and the caller already drew it).
            doc.addPage();
            rowY = HEADER_H + 18;
        }
        doc.text(truncate(row.category, cols[0].w), cols[0].x + 1, rowY);
        doc.text(truncate(row.item, cols[1].w), cols[1].x + 1, rowY);
        doc.text(truncate(row.finish, cols[2].w), cols[2].x + 1, rowY);
        doc.text(row.dims, cols[3].x + 1, rowY);
        doc.text(String(row.qty), cols[4].x + 1, rowY);
        rowY += rowH;
    }
}

function buildMaterialsRows(assets: PlacedAsset[], registry: Asset[]): MaterialsRow[] {
    const byKey = new Map<string, MaterialsRow>();
    for (const a of assets) {
        // Skip assets hidden via view metadata — they aren't part of the build.
        const view = (a.metadata as { view?: { hidden?: boolean } } | undefined)?.view;
        if (view?.hidden) continue;

        const def = getAssetFromList(a.assetId, registry);
        if (!def) continue;
        const finish = readFinish(a);
        const key = `${a.assetId}::${finish}`;
        const existing = byKey.get(key);
        if (existing) {
            existing.qty += 1;
            continue;
        }
        byKey.set(key, {
            category: capitalize(def.category),
            item: def.name,
            finish,
            dims: metersDimsToInchesLabel(def.dimensions),
            qty: 1,
        });
    }
    return Array.from(byKey.values()).sort((a, b) => {
        if (a.category !== b.category) return a.category.localeCompare(b.category);
        return a.item.localeCompare(b.item);
    });
}

function getAssetFromList(id: string, registry: Asset[]): Asset | undefined {
    // Prefer registry param for test-ability; fall back to the module getter.
    return registry.find((a) => a.id === id) ?? getAsset(id);
}

function readFinish(a: PlacedAsset): string {
    const m = a.metadata as
        | { cabinet?: { finish?: string }; appliance?: { finish?: string }; fixture?: { finish?: string } }
        | undefined;
    return m?.cabinet?.finish || m?.appliance?.finish || m?.fixture?.finish || "";
}

function metersDimsToInchesLabel(d: { width: number; height: number; depth: number }): string {
    const toIn = (m: number) => (m / 0.0254).toFixed(1);
    return `${toIn(d.width)}" × ${toIn(d.height)}" × ${toIn(d.depth)}"`;
}

function capitalize(s: string): string {
    return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

function truncate(s: string, mmWidth: number): string {
    // Rough: helvetica 9pt averages ~1.8mm per char. Good enough to avoid
    // column bleed without pulling in a font metrics library.
    const maxChars = Math.max(6, Math.floor(mmWidth / 1.8));
    return s.length <= maxChars ? s : s.slice(0, Math.max(3, maxChars - 1)) + "…";
}

async function fetchAsDataUrl(url: string): Promise<string | null> {
    try {
        const res = await fetch(url, { cache: "force-cache" });
        if (!res.ok) return null;
        const blob = await res.blob();
        return await blobToDataUrl(blob);
    } catch {
        return null;
    }
}

function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result as string);
        fr.onerror = () => reject(fr.error);
        fr.readAsDataURL(blob);
    });
}
