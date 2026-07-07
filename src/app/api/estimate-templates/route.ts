import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// Management surface for the estimate template library (settings/templates).
// Session-authenticated via middleware like the rest of /api.

export async function GET() {
    const templates = await prisma.estimateTemplate.findMany({
        orderBy: [{ source: "desc" }, { name: "asc" }], // standard first, then A-Z
        include: { items: { orderBy: [{ order: "asc" }, { id: "asc" }], select: { type: true, name: true } } },
    });
    return NextResponse.json(templates.map(t => ({
        id: t.id,
        name: t.name,
        source: t.source,
        itemCount: t.items.length,
        phases: t.items.filter(i => i.type === "Section").map(i => i.name),
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        // updatedAt is set on create too; >2s drift means it was actually modified
        modified: t.updatedAt.getTime() - t.createdAt.getTime() > 2000,
    })));
}

export async function PATCH(req: NextRequest) {
    let body: { id?: string; name?: string };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const { id, name } = body;
    if (!id || !name?.trim()) return NextResponse.json({ error: "id and name are required" }, { status: 400 });

    const clash = await prisma.estimateTemplate.findFirst({
        where: { name: { equals: name.trim(), mode: "insensitive" }, id: { not: id } },
        select: { name: true },
    });
    if (clash) return NextResponse.json({ error: `A template named "${clash.name}" already exists` }, { status: 409 });

    const template = await prisma.estimateTemplate.update({ where: { id }, data: { name: name.trim() } });
    return NextResponse.json({ id: template.id, name: template.name });
}

export async function DELETE(req: NextRequest) {
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
    await prisma.estimateTemplate.delete({ where: { id } }); // items cascade
    return NextResponse.json({ ok: true });
}
