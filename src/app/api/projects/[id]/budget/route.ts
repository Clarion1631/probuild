import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getBudgetData } from "@/lib/budget-actions";

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
        where: { email: session.user.email },
    });

    if (!user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (user.role !== "ADMIN" && user.role !== "MANAGER") {
        const permission = await prisma.userPermission.findUnique({
            where: { userId: user.id },
        });
        if (!permission?.financialReports) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }
    }

    const { id: projectId } = await params;

    const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true, name: true },
    });

    if (!project) {
        return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const budgetData = await getBudgetData(projectId);

    return NextResponse.json({ project, ...budgetData });
}
