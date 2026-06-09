import { NextRequest, NextResponse } from "next/server";
import { getQBSettings, saveQBSettings } from "@/lib/integration-store";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest) {
    try {
        const [qb, users] = await Promise.all([
            getQBSettings(),
            prisma.user.findMany({
                where: { status: { not: "DISABLED" } },
                select: { id: true, name: true, email: true, role: true },
                orderBy: { name: "asc" },
            }),
        ]);

        const employeeMappings = (qb as any).employeeMappings || {};
        return NextResponse.json({ employeeMappings, users });
    } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed";
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    try {
        const { employeeMappings } = await req.json();
        if (typeof employeeMappings !== "object") {
            return NextResponse.json({ error: "employeeMappings must be an object" }, { status: 400 });
        }

        await saveQBSettings({ employeeMappings } as any);
        return NextResponse.json({ success: true });
    } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed";
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}
