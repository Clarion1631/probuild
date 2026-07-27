import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { parseProductUrl } from "@/lib/product-parse";
import { ROLES } from "@/lib/permissions";

export const maxDuration = 30;

// POST: team-only product URL parse for the clipper / product library. Full
// ParsedProduct (including price) — team members are allowed to see list price.
export async function POST(req: NextRequest) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.email) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
        const user = await prisma.user.findUnique({ where: { email: session.user.email.toLowerCase() } });
        // Gate on a real staff role, not just "a User row exists" — mirrors
        // /api/users' role-allowlist pattern. ROLES is the canonical
        // ADMIN/MANAGER/FIELD_CREW/FINANCE list from src/lib/permissions.ts.
        if (!user || user.status === "DISABLED" || !ROLES.includes(user.role)) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const body = await req.json().catch(() => null);
        const url = typeof body?.url === "string" ? body.url.trim() : "";
        if (!url) {
            return NextResponse.json({ error: "url required" }, { status: 400 });
        }

        const parsed = await parseProductUrl(url);
        return NextResponse.json(parsed);
    } catch (err: any) {
        console.error("POST /api/products/parse error:", err);
        return NextResponse.json({ error: err.message || "Parse failed" }, { status: 500 });
    }
}
