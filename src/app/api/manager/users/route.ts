export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authenticateMobileOrSession } from "@/lib/mobile-auth";

// MANAGER/ADMIN only — the assignable-crew list for the manager's crew picker
// (src/app/api/manager/jobs/[id]/crew/route.ts POST). ACTIVATED FIELD_CREW or
// MANAGER users are assignable as project crew — ADMIN is not.
export async function GET(req: Request) {
    const auth = await authenticateMobileOrSession(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const { user } = auth;

    if (user.role !== "MANAGER" && user.role !== "ADMIN") {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const users = await prisma.user.findMany({
        where: { status: "ACTIVATED", role: { in: ["FIELD_CREW", "MANAGER"] } },
        orderBy: { name: "asc" },
        select: { id: true, name: true, email: true, role: true },
    });

    return NextResponse.json({ users });
}
