import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await prisma.user.findUnique({ where: { email: session.user.email } });
    if (!user || (user.role !== "ADMIN" && user.role !== "MANAGER")) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;
    const body = await req.json();

    const project = await prisma.project.update({
        where: { id },
        data: {
            ...(body.status && { status: body.status }),
            ...(body.name && { name: body.name }),
            ...(body.type && { type: body.type }),
            ...(body.location && { location: body.location }),
        },
    });

    // Auto-assign ACTIVATED FIELD_CREW (+ CJ) whenever a job moves to
    // "In Progress". Fail-soft inside the helper; never blocks the save.
    const { autoAssignCrewOnStatusChange } = await import("@/lib/crew-auto-assign-sync");
    after(() => autoAssignCrewOnStatusChange(id, project.status));

    return NextResponse.json(project);
}
