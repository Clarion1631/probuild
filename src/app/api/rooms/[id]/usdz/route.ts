// /api/rooms/[id]/usdz — attach the RoomPlan USDZ export to a room design.
// The app uploads the .usdz to Supabase via /api/files/signed-upload first,
// then posts its storagePath here. Powers "View in AR" (Apple Quick Look) in
// the app, the share page, and the client portal.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authenticateMobileOrSession, userCanAccessProject } from "@/lib/mobile-auth";
import { getSupabase, STORAGE_BUCKET } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const auth = await authenticateMobileOrSession(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const { user } = auth;
    const { id } = await params;

    const room = await prisma.roomDesign.findUnique({
        where: { id },
        select: { id: true, name: true, projectId: true, leadId: true },
    });
    if (!room) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // Same owner checks as scan-import: project access or lead management.
    if (room.projectId) {
        const allowed = await userCanAccessProject(user, room.projectId);
        if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    } else if (room.leadId && user.role !== "ADMIN") {
        const lead = await prisma.lead.findFirst({
            where: { id: room.leadId, managerId: user.id },
            select: { id: true },
        });
        if (!lead) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    let body: { storagePath?: unknown };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const storagePath = typeof body.storagePath === "string" ? body.storagePath : "";
    if (!/^(projects|leads)\/[A-Za-z0-9_\-./]+\.usdz$/.test(storagePath)) {
        return NextResponse.json({ error: "storagePath must be a .usdz under projects/ or leads/" }, { status: 400 });
    }

    const supabase = getSupabase();
    if (!supabase) return NextResponse.json({ error: "Storage not configured" }, { status: 500 });
    const { data: urlData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(storagePath);
    const url = urlData.publicUrl;

    await prisma.roomDesign.update({ where: { id }, data: { scanUsdzUrl: url } });

    // Best-effort: drop a copy of the scan into the lead's Drive folder too.
    if (room.leadId) {
        const { mirrorUrlToLeadFolder } = await import("@/lib/lead-drive");
        await mirrorUrlToLeadFolder({
            leadId: room.leadId,
            url,
            name: `${room.name}.usdz`,
            mimeType: "model/vnd.usdz+zip",
        });
    }

    return NextResponse.json({ ok: true, scanUsdzUrl: url });
}
