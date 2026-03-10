import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const { id } = await params;
        const sub = await prisma.subcontractor.findUnique({
            where: { id },
            include: {
                taskAssignments: {
                    include: {
                        task: {
                            include: { project: { select: { name: true } } }
                        }
                    }
                }
            }
        });

        if (!sub) return NextResponse.json({ error: "Subcontractor not found" }, { status: 404 });

        return NextResponse.json(sub);
    } catch (error: any) {
        console.error("GET /api/subcontractors/[id] error:", error);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const { id } = await params;
        const body = await req.json();
        
        const sub = await prisma.subcontractor.update({
            where: { id },
            data: body
        });

        return NextResponse.json(sub);
    } catch (error: any) {
        console.error("PUT /api/subcontractors/[id] error:", error);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const { id } = await params;
        await prisma.subcontractor.delete({ where: { id } });

        return NextResponse.json({ success: true });
    } catch (error: any) {
        console.error("DELETE /api/subcontractors/[id] error:", error);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
