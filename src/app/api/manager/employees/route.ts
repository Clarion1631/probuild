export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { toNum } from "@/lib/prisma-helpers";
import { authenticateMobileOrSession } from "@/lib/mobile-auth";

export async function GET(req: Request) {
    const auth = await authenticateMobileOrSession(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const { user } = auth;

    if (user.role !== "MANAGER" && user.role !== "ADMIN") {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const employees = await prisma.user.findMany({
        where: {
            // Hide DISABLED users from the picker by default; the web /team page is the
            // place to re-enable a disabled user.
            status: { not: "DISABLED" },
        },
        orderBy: [{ name: "asc" }, { email: "asc" }],
        select: {
            id: true,
            email: true,
            name: true,
            role: true,
            status: true,
            hourlyRate: true,
            burdenRate: true,
        },
    });

    return NextResponse.json(
        employees.map((e) => ({
            id: e.id,
            email: e.email,
            name: e.name,
            role: e.role,
            status: e.status,
            hourlyRate: toNum(e.hourlyRate),
            burdenRate: toNum(e.burdenRate),
        }))
    );
}
