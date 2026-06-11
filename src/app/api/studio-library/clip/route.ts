// /api/studio-library/clip — inbox for the "Send to ProBuild" browser
// extension. The extension POSTs raw page text + source URL; clips queue as
// pending and get reviewed on Settings > Design Catalog through the same AI
// extract flow as pasted text.

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const MAX_TEXT = 200_000;
const ALLOWED_STATUS = ["pending", "imported", "dismissed"];

async function getCaller() {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) return null;
    return prisma.user.findUnique({ where: { email: session.user.email } });
}

function canManage(role: string) {
    return role === "ADMIN" || role === "MANAGER";
}

export async function POST(req: Request) {
    const caller = await getCaller();
    if (!caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!canManage(caller.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    let body: { text?: unknown; sourceUrl?: unknown; title?: unknown };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (text.length < 40) {
        return NextResponse.json({ error: "Not enough text - select the product details first" }, { status: 400 });
    }

    const clip = await prisma.clippedImport.create({
        data: {
            text: text.slice(0, MAX_TEXT),
            sourceUrl: typeof body.sourceUrl === "string" ? body.sourceUrl.slice(0, 500) : null,
            title: typeof body.title === "string" ? body.title.slice(0, 200) : null,
            createdById: caller.id,
        },
    });
    return NextResponse.json({ id: clip.id }, { status: 201 });
}

export async function GET() {
    const caller = await getCaller();
    if (!caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!canManage(caller.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const clips = await prisma.clippedImport.findMany({
        where: { status: "pending" },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: { id: true, sourceUrl: true, title: true, text: true, createdAt: true },
    });
    return NextResponse.json({ clips });
}

export async function PATCH(req: Request) {
    const caller = await getCaller();
    if (!caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!canManage(caller.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    let body: { id?: unknown; status?: unknown };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const id = typeof body.id === "string" ? body.id : "";
    const status = typeof body.status === "string" ? body.status : "";
    if (!id || !ALLOWED_STATUS.includes(status)) {
        return NextResponse.json({ error: "id and valid status required" }, { status: 400 });
    }

    try {
        await prisma.clippedImport.update({ where: { id }, data: { status } });
    } catch {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
}
