export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authenticateMobileOrSession, userHasRole } from "@/lib/mobile-auth";

export async function GET(req: NextRequest) {
    const auth = await authenticateMobileOrSession(req);
    if ("error" in auth) return auth.error;
    const { user } = auth;
    if (!userHasRole(user, ["ADMIN", "MANAGER"])) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const employees = await prisma.user.findMany({
        select: {
            id: true,
            email: true,
            name: true,
            role: true,
            status: true,
            hourlyRate: true,
            burdenRate: true,
            invitedAt: true,
        },
        orderBy: [{ status: "asc" }, { name: "asc" }],
    });

    return NextResponse.json(JSON.parse(JSON.stringify(employees)));
}
