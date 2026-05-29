export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authenticateMobileOrSession } from "@/lib/mobile-auth";

const REVIEWER_ROLES = ["MANAGER", "ADMIN", "FINANCE"];

// In-app feed of durable crew-data notifications (time edits, missing receipts, uncoded
// labor, offsite, forgotten clock-outs, skipped meals). GET to list, PATCH to mark read.
export async function GET(req: Request) {
    const auth = await authenticateMobileOrSession(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (!REVIEWER_ROLES.includes(auth.user.role)) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const unreadOnly = searchParams.get("unread") === "true";
    const limit = Math.min(Number(searchParams.get("limit")) || 50, 200);

    const [items, unreadCount] = await Promise.all([
        prisma.notification.findMany({
            where: unreadOnly ? { readAt: null } : {},
            orderBy: { createdAt: "desc" },
            take: limit,
        }),
        prisma.notification.count({ where: { readAt: null } }),
    ]);

    return NextResponse.json({ unreadCount, items: JSON.parse(JSON.stringify(items)) });
}

export async function PATCH(req: Request) {
    const auth = await authenticateMobileOrSession(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (!REVIEWER_ROLES.includes(auth.user.role)) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const now = new Date();

    if (body.all === true) {
        const r = await prisma.notification.updateMany({
            where: { readAt: null },
            data: { readAt: now },
        });
        return NextResponse.json({ ok: true, marked: r.count });
    }

    const ids: string[] = Array.isArray(body.ids) ? body.ids : body.id ? [body.id] : [];
    if (!ids.length) {
        return NextResponse.json({ error: "Provide id, ids[], or all:true" }, { status: 400 });
    }
    const r = await prisma.notification.updateMany({
        where: { id: { in: ids }, readAt: null },
        data: { readAt: now },
    });
    return NextResponse.json({ ok: true, marked: r.count });
}
