// /api/mobile/leads/[id]/notes — append a note from the field.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authenticateMobileOrSession } from "@/lib/mobile-auth";
import { assertLeadAccess } from "@/lib/lead-access";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const auth = await authenticateMobileOrSession(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const { id } = await params;

    const fail = await assertLeadAccess(auth.user, id);
    if (fail) return fail;

    let body: { content?: unknown };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const content = typeof body.content === "string" ? body.content.trim() : "";
    if (!content) return NextResponse.json({ error: "Note text required" }, { status: 400 });

    const note = await prisma.leadNote.create({
        data: {
            leadId: id,
            content: content.slice(0, 4000),
            createdBy: auth.user.name ?? auth.user.email,
        },
        select: { id: true, content: true, createdBy: true, createdAt: true },
    });
    await prisma.lead.update({ where: { id }, data: { lastActivityAt: new Date() } });

    return NextResponse.json({ note }, { status: 201 });
}
