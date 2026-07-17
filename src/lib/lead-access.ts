// Shared lead-access gate for mobile lead routes: ADMINs see every lead,
// everyone else only leads they manage (matches /api/files/signed-upload).

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function assertLeadAccess(
    user: { id: string; role: string },
    leadId: string,
): Promise<NextResponse | null> {
    const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { managerId: true } });
    if (!lead) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (user.role === "ADMIN") return null;
    if (lead.managerId !== user.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    return null;
}
