// /api/rooms/[id]/render — AI photoreal renders of a room.
//
// POST { image: dataUrl } captures the caller's current studio view, runs it
// through Gemini image-out with a prompt built from the design doc (real
// finish names, library entries included), stores the PNG in Supabase
// storage, and records a RoomRender row. GET lists renders; DELETE removes.

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { GoogleGenAI } from "@google/genai";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { fromRoomRecord, type ApiRoomAsset } from "@/lib/studio/doc";
import { buildRenderPrompt, collectLibraryFinishIds, type ProductInfo } from "@/lib/studio/render-prompt";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // Gemini image generation takes ~10-25s

const RENDER_MODEL = "gemini-2.5-flash-image";
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // request stays under Vercel's body cap
const MAX_RENDERS_PER_ROOM = 24;

interface RouteParams { params: Promise<{ id: string }> }

async function getCaller() {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) return null;
    return prisma.user.findUnique({ where: { email: session.user.email } });
}

// Same access rule and status semantics as /api/rooms/[id]: 404 when the
// room doesn't exist, 403 when it exists but the caller can't touch it.
async function canAccessRoom(userId: string, role: string, roomId: string): Promise<{
    exists: boolean;
    allowed: boolean;
}> {
    const room = await prisma.roomDesign.findUnique({
        where: { id: roomId },
        select: { id: true, projectId: true, leadId: true },
    });
    if (!room) return { exists: false, allowed: false };
    if (role === "ADMIN" || role === "MANAGER") return { exists: true, allowed: true };
    if (room.projectId) {
        const pa = await prisma.projectAccess.findFirst({
            where: { userId, projectId: room.projectId },
            select: { id: true },
        });
        if (pa) return { exists: true, allowed: true };
        const crew = await prisma.project.findFirst({
            where: { id: room.projectId, crew: { some: { id: userId } } },
            select: { id: true },
        });
        return { exists: true, allowed: !!crew };
    }
    if (room.leadId) {
        const lead = await prisma.lead.findFirst({
            where: { id: room.leadId, managerId: userId },
            select: { id: true },
        });
        return { exists: true, allowed: !!lead };
    }
    return { exists: true, allowed: false };
}

function accessError(check: { exists: boolean; allowed: boolean }) {
    if (!check.exists) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

export async function GET(_req: Request, { params }: RouteParams) {
    const { id } = await params;
    const caller = await getCaller();
    if (!caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const access = await canAccessRoom(caller.id, caller.role, id);
    if (!access.allowed) return accessError(access);
    const renders = await prisma.roomRender.findMany({
        where: { roomDesignId: id },
        orderBy: { createdAt: "desc" },
    });
    return NextResponse.json({ renders });
}

export async function POST(req: Request, { params }: RouteParams) {
    const { id } = await params;
    const caller = await getCaller();
    if (!caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const access = await canAccessRoom(caller.id, caller.role, id);
    if (!access.allowed) return accessError(access);

    if (!process.env.GEMINI_API_KEY) {
        return NextResponse.json({ error: "AI rendering not configured" }, { status: 500 });
    }

    let body: { image?: unknown };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const image = typeof body.image === "string" ? body.image : "";
    const m = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/=]+)$/.exec(image);
    if (!m) return NextResponse.json({ error: "image must be a jpeg/png data URL" }, { status: 400 });
    const inputB64 = m[2];
    if (inputB64.length * 0.75 > MAX_IMAGE_BYTES) {
        return NextResponse.json({ error: "Image too large" }, { status: 413 });
    }

    const count = await prisma.roomRender.count({ where: { roomDesignId: id } });
    if (count >= MAX_RENDERS_PER_ROOM) {
        return NextResponse.json(
            { error: `Render limit reached (${MAX_RENDERS_PER_ROOM} per room) - delete old renders first` },
            { status: 429 },
        );
    }

    const room = await prisma.roomDesign.findUnique({ where: { id }, include: { assets: true } });
    if (!room) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const doc = fromRoomRecord({
        id: room.id,
        name: room.name,
        roomType: room.roomType,
        layoutJson: room.layoutJson,
        assets: room.assets.map((a) => ({
            id: a.id,
            assetType: a.assetType,
            assetId: a.assetId,
            positionX: a.positionX,
            positionY: a.positionY,
            positionZ: a.positionZ,
            rotationY: a.rotationY,
            scaleX: a.scaleX,
            scaleY: a.scaleY,
            scaleZ: a.scaleZ,
            metadata: (a.metadata ?? null) as Record<string, unknown> | null,
        })) as ApiRoomAsset[],
    });

    // Library finish names (lib-<cuid> ids) come from the DB. Library products
    // (prod-* defIds) can carry lib-* DEFAULT finishes on their catalog row,
    // which the server-side registry doesn't know - pull those too.
    const libIds = new Set(collectLibraryFinishIds(doc));
    const prodIds = [...new Set(doc.items.map((i) => i.defId).filter((d) => d.startsWith("prod-")))];
    const prodInfo: ProductInfo = new Map();
    if (prodIds.length) {
        const prods = await prisma.catalogProduct.findMany({
            where: { id: { in: prodIds.map((x) => x.slice(5)) } },
            select: { id: true, name: true, vendor: true, finishes: true },
        });
        for (const p of prods) {
            const finishes: Record<string, string> = {};
            for (const [slot, v] of Object.entries((p.finishes ?? {}) as Record<string, unknown>)) {
                if (typeof v === "string") {
                    finishes[slot] = v;
                    if (v.startsWith("lib-")) libIds.add(v);
                }
            }
            prodInfo.set(`prod-${p.id}`, {
                name: p.vendor ? `${p.name} (${p.vendor})` : p.name,
                finishes,
            });
        }
    }
    const libNames = new Map<string, string>();
    if (libIds.size) {
        const rows = await prisma.catalogFinish.findMany({
            where: { id: { in: [...libIds].map((x) => x.slice(4)) } },
            select: { id: true, name: true, vendor: true },
        });
        for (const r of rows) libNames.set(`lib-${r.id}`, r.vendor ? `${r.name} (${r.vendor})` : r.name);
    }

    const prompt = buildRenderPrompt(doc, room.roomType, libNames, prodInfo);

    try {
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        const res = await ai.models.generateContent({
            model: RENDER_MODEL,
            contents: [{
                role: "user",
                parts: [
                    { inlineData: { mimeType: `image/${m[1]}`, data: inputB64 } },
                    { text: prompt },
                ],
            }],
            config: { responseModalities: ["TEXT", "IMAGE"] },
        });
        const parts = res.candidates?.[0]?.content?.parts ?? [];
        const imgPart = parts.find((p) => p.inlineData?.data);
        if (!imgPart?.inlineData?.data) {
            const text = parts.find((p) => p.text)?.text?.slice(0, 200);
            return NextResponse.json(
                { error: text ? `Model returned no image: ${text}` : "Model returned no image" },
                { status: 502 },
            );
        }

        const buffer = Buffer.from(imgPart.inlineData.data, "base64");
        const { getSupabase, STORAGE_BUCKET } = await import("@/lib/supabase");
        const supabase = getSupabase();
        if (!supabase) return NextResponse.json({ error: "Storage not configured" }, { status: 500 });

        const ext = imgPart.inlineData.mimeType === "image/jpeg" ? "jpg" : "png";
        const storagePath = `rooms/${id}/renders/${Date.now()}.${ext}`;
        const { error: uploadError } = await supabase.storage
            .from(STORAGE_BUCKET)
            .upload(storagePath, buffer, { contentType: imgPart.inlineData.mimeType ?? "image/png", upsert: false });
        if (uploadError) {
            return NextResponse.json({ error: `Upload failed: ${uploadError.message}` }, { status: 500 });
        }
        const { data: urlData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(storagePath);

        const render = await prisma.roomRender.create({
            data: { roomDesignId: id, url: urlData.publicUrl },
        });
        return NextResponse.json({ render }, { status: 201 });
    } catch (e) {
        console.error("Room render failed:", e);
        const msg = e instanceof Error ? e.message : "Render failed";
        return NextResponse.json({ error: msg.slice(0, 300) }, { status: 502 });
    }
}

export async function DELETE(req: Request, { params }: RouteParams) {
    const { id } = await params;
    const caller = await getCaller();
    if (!caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const access = await canAccessRoom(caller.id, caller.role, id);
    if (!access.allowed) return accessError(access);

    const renderId = new URL(req.url).searchParams.get("renderId");
    if (!renderId) return NextResponse.json({ error: "renderId required" }, { status: 400 });

    const render = await prisma.roomRender.findFirst({ where: { id: renderId, roomDesignId: id } });
    if (!render) return NextResponse.json({ error: "Not found" }, { status: 404 });

    await prisma.roomRender.delete({ where: { id: render.id } });

    // best-effort storage cleanup
    try {
        const { getSupabase, STORAGE_BUCKET } = await import("@/lib/supabase");
        const supabase = getSupabase();
        const marker = `/object/public/${STORAGE_BUCKET}/`;
        const idx = render.url.indexOf(marker);
        if (supabase && idx !== -1) {
            await supabase.storage.from(STORAGE_BUCKET).remove([decodeURIComponent(render.url.slice(idx + marker.length))]);
        }
    } catch (e) {
        console.error("Render storage cleanup failed:", e);
    }
    return NextResponse.json({ ok: true });
}
